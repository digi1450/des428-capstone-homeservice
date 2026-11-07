import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { importSnapshot, validateSnapshot } from './import-snapshot.mjs';
import { createDatabase as notificationsDatabase } from '../../services/notifications/src/database.js';
import { createDatabase as paymentsDatabase } from '../../services/payments-wallet/src/database.js';
import { migrate as migrateNotifications } from '../../services/notifications/src/migrations.js';
import { migrate as migratePayments } from '../../services/payments-wallet/src/migrations.js';
import { createNotificationsService } from '../../services/notifications/src/service.js';
import { createPaymentsService } from '../../services/payments-wallet/src/service.js';

const directory = process.env.SNAPSHOT_FIXTURE_DIR;
if (!directory || !process.env.NOTIFICATIONS_TEST_URL || !process.env.PAYMENTS_TEST_URL) throw new Error('Dedicated migration test environment required');
const envName = service => service === 'notifications' ? 'NOTIFICATIONS_TEST_URL' : 'PAYMENTS_TEST_URL';
const clone = value => structuredClone(value);
const input = async service => JSON.parse(await readFile(`${directory}/${service}.json`,'utf8'));

test('snapshot validation rejects wrong-owner, incomplete and inconsistent data before SQL', async () => {
  const n = await input('notifications'), p = await input('payments-wallet');
  assert.throws(() => validateSnapshot('payments-wallet',n), /OWNER/);
  const unknown = clone(n); unknown.tables.orders = []; assert.throws(() => validateSnapshot('notifications',unknown), /OWNERSHIP/);
  const missing = clone(n); delete missing.tables.notifications[0].recipient_id; assert.throws(() => validateSnapshot('notifications',missing), /COLUMNS/);
  const overflow = clone(n); overflow.tables.notifications[0].id = 2147483648; assert.throws(() => validateSnapshot('notifications',overflow), /RANGE/);
  const badDate = clone(n); badDate.tables.notifications[0].created_at = 'yesterday'; assert.throws(() => validateSnapshot('notifications',badDate), /TIMESTAMP/);
  for (const value of ['2026-02-30T00:00:00.000Z','2026-11-06T00:00:00.000001Z']) {
    const changed = clone(n); changed.tables.notifications[0].created_at=value;
    assert.throws(() => validateSnapshot('notifications',changed), /TIMESTAMP/);
  }
  const duplicate = clone(p); duplicate.tables.transactions.push({...p.tables.transactions[0],id:201}); assert.throws(() => validateSnapshot('payments-wallet',duplicate), /DUPLICATE_LEDGER/);
  const wrongWallet = clone(p); wrongWallet.tables.provider_wallets[0].balance_cents++; assert.throws(() => validateSnapshot('payments-wallet',wrongWallet), /WALLET_LEDGER/);
  const badContext = clone(p); badContext.tables.transactions.find(row => row.kind === 'payout_credit').context_json.commission_cents++; assert.throws(() => validateSnapshot('payments-wallet',badContext), /COMPLETION_AMOUNT/);
  const lostCharge = clone(p); lostCharge.tables.transactions = lostCharge.tables.transactions.filter(row => row.kind !== 'charge'); assert.throws(() => validateSnapshot('payments-wallet',lostCharge), /CONTEXT|MISMATCH/);
  const badReceipt = clone(p); badReceipt.tables.webhook_events[0].payload_json.gateway_ref = 'missing'; assert.throws(() => validateSnapshot('payments-wallet',badReceipt), /WEBHOOK_CONTEXT/);
});

for (const [service,createDatabase,migrate,env] of [
  ['notifications',notificationsDatabase,migrateNotifications,'NOTIFICATIONS_TEST_URL'],
  ['payments-wallet',paymentsDatabase,migratePayments,'PAYMENTS_TEST_URL']]) {
  test(`${service}: actual PostgreSQL dry-run, import, replay, rejection and business continuation`, async t => {
    const db = createDatabase(process.env[env]);
    const bundle = await input(service);
    const tables = Object.keys(bundle.tables);
    const messageTable = service === 'notifications' ? 'processed_events' : 'outbox_events';
    const eventId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const addMessageState = async client => {
      if (service === 'notifications') {
        await client.query("INSERT INTO processed_events (consumer_name,event_id,event_type,producer,effect_count) VALUES ('migration-probe',$1,'payment.succeeded','payments-wallet',0)",[eventId]);
      } else {
        await client.query("INSERT INTO outbox_events (event_id,event_type,aggregate_type,aggregate_id,envelope) VALUES ($1,'payment.succeeded','order','10',$2::jsonb)",[eventId,JSON.stringify({event_id:eventId,event_type:'payment.succeeded'})]);
      }
    };
    const clearMessageState = () => db.query(`DELETE FROM ${messageTable} WHERE event_id=$1`,[eventId]);
    const messageRows = async () => (await db.query(`SELECT * FROM ${messageTable}`)).rows;
    const sequence = service === 'notifications' ? 'notifications_id_seq' : 'payment_intents_id_seq';
    try {
      await migrate(db);
      const seq = async () => (await db.query(`SELECT last_value,is_called FROM ${sequence}`)).rows[0];
      const before = await seq();
      await t.test('future schema additions require migration-tool review before writes', async () => {
        await db.query("INSERT INTO schema_migrations (version,sha256) VALUES ('999_fixture.sql','fixture')");
        try { await assert.rejects(importSnapshot(db,service,bundle,{apply:true}), /SCHEMA_REVIEW_REQUIRED/); }
        finally { await db.query("DELETE FROM schema_migrations WHERE version='999_fixture.sql'"); }
      });
      await t.test('existing C message state rejects dry-run/apply before inserting business rows', async () => {
        await addMessageState(db);
        const messages = await messageRows(), state = await seq();
        try {
          for (const apply of [false,true]) {
            await assert.rejects(importSnapshot(db,service,bundle,{apply}), /MESSAGE_STATE_NOT_EMPTY/);
            for (const table of tables) assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0);
            assert.deepEqual(await seq(),state);
            assert.deepEqual(await messageRows(),messages);
          }
        } finally { await clearMessageState(); }
      });
      await t.test('message state committed while waiting for locks is seen before any import writes', async () => {
        let signalReady, releaseWriter;
        const ready = new Promise(resolve => { signalReady = resolve; });
        const release = new Promise(resolve => { releaseWriter = resolve; });
        const writer = db.withTransaction(async client => {
          await addMessageState(client);
          signalReady();
          await release;
        });
        // Also surface a failed writer instead of waiting forever for readiness.
        await Promise.race([ready,writer.then(() => { throw new Error('writer ended before ready'); })]);
        const result = importSnapshot(db,service,bundle,{apply:true}).then(value => ({value}),error => ({error}));
        try {
          const deadline = Date.now()+1200;
          let waiting = false;
          while (!waiting && Date.now()<deadline) {
            const locks = await db.query('SELECT 1 FROM pg_locks WHERE relation=$1::regclass AND mode=$2 AND NOT granted', [messageTable,'AccessExclusiveLock']);
            waiting = locks.rowCount > 0;
            if (!waiting) await new Promise(resolve => setTimeout(resolve,10));
          }
          assert.ok(waiting,'importer must wait on the active message-table writer');
        } finally { releaseWriter(); await writer; }
        try {
          const outcome = await result;
          assert.match(outcome.error?.message ?? '',/MESSAGE_STATE_NOT_EMPTY/);
          for (const table of tables) assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0);
          assert.equal((await messageRows()).length,1);
        } finally { await clearMessageState(); }
      });
      await t.test('CLI defaults to dry-run and does not log credentials on failure', async () => {
        const args = ['import-cli.mjs',service,`${directory}/${service}.json`];
        const env = {...process.env,DATABASE_URL:process.env[envName(service)]};
        const report=JSON.parse(execFileSync(process.execPath,args,{env,encoding:'utf8'}));
        assert.equal(report.mode,'dry-run');
        assert.throws(() => execFileSync(process.execPath,[...args,'--invalid'],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']}), error => {
          assert.match(error.stderr,/IMPORT_REJECTED/);
          assert.ok(!error.stderr.includes('migration-fixture-only'));
          return true;
        });
      });
      await t.test('dry-run validates real inserts then rolls back rows AND sequence state', async () => {
        const report = await importSnapshot(db,service,bundle);
        assert.equal(report.mode,'dry-run');
        for (const table of tables) assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0);
        assert.deepEqual(await seq(),before);
      });
      await t.test('apply preserves every row and repeated apply is an exact replay', async () => {
        const report = await importSnapshot(db,service,bundle,{apply:true});
        assert.equal(report.action,'import');
        for (const table of tables) assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,bundle.tables[table].length);
        assert.deepEqual(await messageRows(),[]);
        const replay = await importSnapshot(db,service,bundle,{apply:true});
        assert.equal(replay.action,'identical-replay'); assert.equal(replay.sha256,report.sha256);
      });
      await t.test('even an exact business replay rejects existing C state without modifying it', async () => {
        await addMessageState(db);
        const messages = await messageRows(), state = await seq();
        try {
          for (const apply of [false,true]) {
            await assert.rejects(importSnapshot(db,service,bundle,{apply}), /MESSAGE_STATE_NOT_EMPTY/);
            assert.deepEqual(await messageRows(),messages);
            assert.deepEqual(await seq(),state);
          }
        } finally { await clearMessageState(); }
        assert.equal((await importSnapshot(db,service,bundle,{apply:true})).action,'identical-replay');
      });
      await t.test('replay does not lower an already advanced identity sequence', async () => {
        const table = service === 'notifications' ? 'notifications' : 'payment_intents';
        await db.query(`ALTER TABLE ${table} ALTER COLUMN id RESTART WITH 500`);
        await importSnapshot(db,service,bundle,{apply:true});
        assert.equal(Number((await seq()).last_value),500);
        assert.equal((await seq()).is_called,false);
      });
      await t.test('mismatched nonempty target is rejected without overwriting it', async () => {
        const changed = clone(bundle);
        if (service === 'notifications') changed.tables.notifications[0].title = 'changed';
        else changed.tables.payment_intents[2].gateway_ref = 'SIM-changed';
        await assert.rejects(importSnapshot(db,service,changed,{apply:true}), /TARGET_NOT_EMPTY_OR_IDENTICAL/);
        assert.equal((await importSnapshot(db,service,bundle,{apply:true})).action,'identical-replay');
      });
      await t.test('database failure after first insert rolls back the entire service import', async () => {
        // Dedicated disposable fixture database only; never a production cleanup command.
        await db.query(`TRUNCATE ${tables.join(',')}`);
        const failing = {checkReady:() => db.checkReady(), withTransaction: work => db.withTransaction(async client => {
          let inserts = 0;
          return work({query:async (sql,values) => {
            if (sql.startsWith('INSERT') && ++inserts === 2) throw new Error('fixture insert failure');
            return client.query(sql,values);
          }});
        })};
        const state = await seq();
        await assert.rejects(importSnapshot(failing,service,bundle,{apply:true}), /fixture insert failure/);
        for (const table of tables) assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0);
        assert.deepEqual(await seq(),state);
        await importSnapshot(db,service,bundle,{apply:true});
      });
      if (service === 'notifications') {
        await t.test('notification IDs/read state survive, next record cannot collide', async () => {
          const api = createNotificationsService(db);
          const old = (await db.query('SELECT * FROM notifications WHERE id=75')).rows[0];
          assert.equal(old.read_at.toISOString(),'2026-11-06T00:00:00.000Z');
          const next = await api.record({recipientRole:'provider',recipientId:7,type:'fixture',title:'Fixture',body:'Fixture',orderId:13});
          assert.ok(next.id > 75);
        });
      } else {
        await t.test('completion replay does not credit wallet again; owners/history remain usable', async () => {
          const api = createPaymentsService(db);
          const context = bundle.tables.transactions.find(row => row.kind === 'payout_credit').context_json;
          const before = await api.getWallet({role:'provider',domainId:7});
          const completion = await api.applyCompletion(context);
          assert.equal(completion.id,110);
          const codContext=bundle.tables.transactions.find(row => row.kind === 'commission_owed').context_json;
          assert.equal((await api.applyCompletion(codContext)).id,130);
          assert.equal((await api.applyRefund({order_id:11,customer_id:5,provider_id:7,amount_cents:2000})).id,121);
          assert.deepEqual(await api.getWallet({role:'provider',domainId:7}),before);
          const history = await api.listCustomerTransactions({role:'customer',domainId:5});
          assert.equal(history.length,5); assert.ok(history.find(row => row.id === 121 && row.status === 'refunded'));
          const intent = await api.getIntentForOrder(10,{role:'customer',domainId:5}); assert.equal(intent.id,40);
        });
        await t.test('old webhook replay stays deduped without new charge/event', async () => {
          let events=0;
          const api=createPaymentsService(db,{assertSettlementAllowed:async()=>true,stageEvent:async()=>{events++;}});
          const receipt=bundle.tables.webhook_events[0].payload_json;
          assert.deepEqual(await api.settleWebhook(receipt),{replayed:true});
          assert.equal(events,0);
          assert.equal((await db.query('SELECT count(*)::int AS n FROM transactions')).rows[0].n,5);
        });
        await t.test('all identity sequences advance past imported maxima without lowering advanced values', async () => {
          const api=createPaymentsService(db);
          const intent=await api.prepareIntent({order_id:20,customer_id:5,provider_id:7,amount_cents:100,currency:'THB'});
          assert.ok(intent.id>45);
          const commission=await api.applyCompletion({order_id:21,customer_id:5,provider_id:7,amount_cents:100,commission_cents:15,payment_method:'cod'});
          assert.ok(commission.id>130);
          const receipt=(await db.query("INSERT INTO webhook_events (gateway_event_id,type,payload_json) VALUES ('fixture-next','fixture','{}') RETURNING id")).rows[0];
          assert.ok(receipt.id>62);
        });
      }
    } finally { await db.close(); }
  });
}
