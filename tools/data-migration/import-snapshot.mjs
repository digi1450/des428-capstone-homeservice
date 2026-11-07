// Offline administration only; never called by a live service request.
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';

export const columns = {
  notifications: ['id','recipient_role','recipient_id','type','title','body','order_id','read_at','created_at'],
  payment_intents: ['id','order_id','customer_id','provider_id','amount_cents','currency','gateway_ref','status','created_at'],
  transactions: ['id','order_id','customer_id','provider_id','kind','amount_cents','method','gateway_ref','status','created_at','context_json'],
  provider_wallets: ['provider_id','balance_cents','commission_owed_cents','updated_at'],
  webhook_events: ['id','gateway_event_id','type','payload_json','received_at','processed_at'],
};
// Reviewed C migrations add consumer-dedupe/outbox tables, not imported business columns.
// Offline import requires those tables to be empty and keeps them empty; never clear
// existing delivery state or replay historical events to make an import succeed.
const expectedMigrations = {notifications:['001_initial.sql','002_processed_events.sql'], 'payments-wallet':['001_initial.sql','002_ledger_invariants.sql','003_outbox.sql']};
const owned = { notifications: ['notifications'], 'payments-wallet': ['payment_intents','transactions','provider_wallets','webhook_events'] };
const messageTables = {notifications:['processed_events'], 'payments-wallet':['outbox_events']};
const jsonColumns = new Set(['context_json','payload_json']);
const timestamps = new Set(['read_at','created_at','updated_at','received_at','processed_at']);
const integers = new Set(['id','recipient_id','order_id','customer_id','provider_id','amount_cents','balance_cents','commission_owed_cents']);
const nullable = new Set(['order_id','read_at','gateway_ref']);
const fail = code => { throw new Error(code); };
const require = (value, code) => { if (!value) fail(code); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const int = (value, min=1) => Number.isInteger(value) && value >= min && value <= 2147483646;
const validTimestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(Z|\+00:00)$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value.replace('+00:00','Z');
const key = table => table === 'provider_wallets' ? 'provider_id' : 'id';
function normalize(table, row) {
  return Object.fromEntries(columns[table].map(column => {
    let value = row[column];
    if (timestamps.has(column) && value !== null) value = new Date(value).toISOString();
    return [column,value];
  }));
}

export function validateSnapshot(service, bundle) {
  require(owned[service] && plain(bundle), 'INVALID_SERVICE_OR_SNAPSHOT');
  require(bundle.format_version === 1 && bundle.service === service, 'SNAPSHOT_VERSION_OR_OWNER');
  require(typeof bundle.snapshot_id === 'string' && /^[a-f0-9-]{36}$/.test(bundle.snapshot_id), 'SNAPSHOT_ID');
  require(Number.isSafeInteger(bundle.legacy_event_watermark) && bundle.legacy_event_watermark >= 0, 'EVENT_WATERMARK');
  require(typeof bundle.exported_at === 'string' && Number.isFinite(Date.parse(bundle.exported_at)), 'EXPORT_TIME');
  require(plain(bundle.tables) && isDeepStrictEqual(Object.keys(bundle.tables).sort(), [...owned[service]].sort()), 'TABLE_OWNERSHIP');
  const tables = {};
  for (const table of owned[service]) {
    const rows = bundle.tables[table];
    require(Array.isArray(rows), 'INVALID_TABLE');
    const ids = new Set();
    for (const row of rows) {
      require(plain(row) && isDeepStrictEqual(Object.keys(row).sort(), [...columns[table]].sort()), 'ROW_COLUMNS');
      for (const column of columns[table]) {
        const value = row[column];
        if (value === null) { require(nullable.has(column), 'UNEXPECTED_NULL'); continue; }
        if (integers.has(column)) require(int(value, column.endsWith('_cents') ? 0 : 1), 'INTEGER_RANGE');
        else if (timestamps.has(column)) require(validTimestamp(value), 'TIMESTAMP');
        else if (jsonColumns.has(column)) require(plain(value), 'JSON_OBJECT_REQUIRED');
        else require(typeof value === 'string', 'STRING_REQUIRED');
      }
      require(!ids.has(row[key(table)]), 'DUPLICATE_PRIMARY_KEY'); ids.add(row[key(table)]);
      if (table === 'transactions' || table === 'payment_intents') {
        for (const column of ['order_id','customer_id','provider_id']) require(int(row[column]), 'MISSING_FINANCIAL_CONTEXT');
      }
    }
    tables[table] = rows.map(row => normalize(table,row)).sort((a,b) => a[key(table)] - b[key(table)]);
  }
  if (service === 'notifications') {
    for (const row of tables.notifications) {
      require(['customer','provider','admin'].includes(row.recipient_role), 'RECIPIENT_ROLE');
      require(row.type && row.title && row.body, 'NOTIFICATION_CONTENT');
    }
  } else validatePayments(tables);
  return tables;
}
function validatePayments(tables) {
  const intents = new Map(), refs = new Set(), effects = new Map();
  const wallets = new Map(tables.provider_wallets.map(row => [row.provider_id,row]));
  for (const intent of tables.payment_intents) {
    require(intent.currency === 'THB' && ['requires_payment','succeeded','failed'].includes(intent.status), 'INTENT_ENUM');
    require(intent.gateway_ref && !refs.has(intent.gateway_ref) && !intents.has(intent.order_id), 'DUPLICATE_INTENT');
    refs.add(intent.gateway_ref); intents.set(intent.order_id,intent);
    require(wallets.has(intent.provider_id), 'MISSING_WALLET');
  }
  const sums = new Map([...wallets.keys()].map(id => [id,{balance:0,commission:0}]));
  for (const row of tables.transactions) {
    require(['charge','payout_credit','commission_owed','refund'].includes(row.kind) && ['cod','gateway'].includes(row.method), 'LEDGER_ENUM');
    require(row.status === (row.kind === 'refund' ? 'refunded' : 'succeeded'), 'UNSUPPORTED_LEDGER_STATUS');
    const effect = `${row.order_id}:${row.kind}`;
    require(!effects.has(effect), 'DUPLICATE_LEDGER_EFFECT'); effects.set(effect,row);
    require(wallets.has(row.provider_id), 'MISSING_WALLET');
    const intent = intents.get(row.order_id);
    if (row.method === 'gateway') {
      require(intent && intent.customer_id === row.customer_id && intent.provider_id === row.provider_id, 'LEDGER_INTENT_CONTEXT');
    } else require(!intent && row.kind === 'commission_owed', 'COD_CONTEXT');
    if (['payout_credit','commission_owed'].includes(row.kind)) {
      const ctx = row.context_json;
      require(int(ctx.amount_cents,0) && int(ctx.commission_cents,0) && ctx.commission_cents <= ctx.amount_cents
        && ctx.order_id === row.order_id && ctx.customer_id === row.customer_id && ctx.provider_id === row.provider_id
        && ctx.payment_method === row.method, 'COMPLETION_CONTEXT');
      require(row.kind === (row.method === 'gateway' ? 'payout_credit' : 'commission_owed'), 'COMPLETION_KIND');
      require(row.amount_cents === (row.kind === 'payout_credit' ? ctx.amount_cents-ctx.commission_cents : ctx.commission_cents), 'COMPLETION_AMOUNT');
      if (intent) require(intent.amount_cents === ctx.amount_cents, 'COMPLETION_INTENT_AMOUNT');
      sums.get(row.provider_id)[row.kind === 'payout_credit' ? 'balance' : 'commission'] += row.amount_cents;
    } else {
      require(row.method === 'gateway' && row.amount_cents === intent.amount_cents && intent.status === 'succeeded', 'SETTLEMENT_CONTEXT');
      if (row.kind === 'charge') require(row.gateway_ref === intent.gateway_ref, 'CHARGE_REFERENCE');
    }
  }
  for (const row of tables.transactions) {
    if (row.kind === 'refund') require(effects.has(`${row.order_id}:charge`) && !effects.has(`${row.order_id}:payout_credit`), 'REFUND_CONTEXT');
  }
  for (const intent of intents.values()) require((intent.status === 'succeeded') === effects.has(`${intent.order_id}:charge`), 'SETTLED_CHARGE_MISMATCH');
  for (const [id, wallet] of wallets) require(wallet.balance_cents === sums.get(id).balance && wallet.commission_owed_cents === sums.get(id).commission, 'WALLET_LEDGER_MISMATCH');
  const events = new Set();
  for (const receipt of tables.webhook_events) {
    require(receipt.gateway_event_id && !events.has(receipt.gateway_event_id), 'DUPLICATE_WEBHOOK'); events.add(receipt.gateway_event_id);
    require(receipt.type === 'payment_intent.succeeded' && receipt.payload_json.type === receipt.type
      && receipt.payload_json.gateway_event_id === receipt.gateway_event_id && refs.has(receipt.payload_json.gateway_ref), 'WEBHOOK_CONTEXT');
  }
}
class DryRun extends Error { constructor(report) { super('DRY_RUN'); this.report = report; } }
export async function importSnapshot(database, service, bundle, { apply = false } = {}) {
  const tables = validateSnapshot(service,bundle);
  const report = { service, snapshot_id: bundle.snapshot_id, mode: apply ? 'apply' : 'dry-run',
    sha256: createHash('sha256').update(JSON.stringify(tables)).digest('hex'),
    counts: Object.fromEntries(Object.entries(tables).map(([name,rows]) => [name,rows.length])) };
  await database.checkReady();
  try {
    return await database.withTransaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      // Lock before the first snapshot-taking SELECT: a writer already in flight
      // must commit/roll back before the emptiness check can choose a snapshot.
      await client.query(`LOCK TABLE ${[...owned[service],...messageTables[service]].join(',')} IN ACCESS EXCLUSIVE MODE`);
      const versions = (await client.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(row => row.version);
      require(isDeepStrictEqual(versions,expectedMigrations[service]), 'SCHEMA_REVIEW_REQUIRED');
      for (const table of messageTables[service]) {
        require((await client.query(`SELECT 1 FROM ${table} LIMIT 1`)).rowCount === 0, 'MESSAGE_STATE_NOT_EMPTY');
      }
      const read = async table => (await client.query(`SELECT ${columns[table].join(',')} FROM ${table} ORDER BY ${key(table)}`)).rows.map(row => normalize(table,row));
      const current = {};
      for (const table of owned[service]) current[table] = await read(table);
      const empty = Object.values(current).every(rows => rows.length === 0);
      require(empty || isDeepStrictEqual(current,tables), 'TARGET_NOT_EMPTY_OR_IDENTICAL');
      if (empty) {
        for (const table of owned[service]) {
          for (const row of tables[table]) {
            const cols = columns[table];
            const values = cols.map(column => jsonColumns.has(column) ? JSON.stringify(row[column]) : row[column]);
            await client.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((_,i) => '$'+(i+1)).join(',')})`, values);
          }
        }
      }
      for (const table of owned[service]) {
        require(isDeepStrictEqual(await read(table),tables[table]), 'IMPORT_VERIFICATION_FAILED');
        if (key(table) !== 'id') continue;
        const sequence = (await client.query('SELECT pg_get_serial_sequence($1, $2) AS name',[table,'id'])).rows[0].name;
        require(typeof sequence === 'string' && /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(sequence), 'UNEXPECTED_SEQUENCE');
        const state = (await client.query(`SELECT last_value, is_called FROM ${sequence}`)).rows[0];
        const max = tables[table].at(-1)?.id ?? 0;
        const next = Math.max(max+1, Number(state.last_value)+(state.is_called ? 1 : 0));
        require(int(next), 'IDENTITY_EXHAUSTED');
        // ALTER ... RESTART is transactional. setval() would survive dry-run rollback.
        await client.query(`ALTER TABLE ${table} ALTER COLUMN id RESTART WITH ${next}`);
      }
      const result = {...report, action: empty ? 'import' : 'identical-replay'};
      if (!apply) throw new DryRun(result);
      return result;
    });
  } catch (error) {
    if (error instanceof DryRun) return error.report;
    throw error;
  }
}
