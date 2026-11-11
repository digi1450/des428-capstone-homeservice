#!/usr/bin/env node
import {checkBroker,QUEUES} from "./broker-check.mjs";
export {checkBroker,QUEUES};
// Area C — read-only consistency checker for cutover rehearsal, rollback and incident review.
//
// It never writes, publishes, acks or repairs anything. It reads one snapshot from each owner:
//   monolith SQLite (Booking/saga/outbox/inbox/financial work)  --sqlite <file>      (opened read-only)
//   Payments & Wallet PostgreSQL                              --payments-url <url> (READ ONLY REPEATABLE READ tx)
//   Notifications PostgreSQL (optional)                       --notifications-url <url>
//   RabbitMQ (optional, passive checks + read-only management GET for unacked counts)
// and reports findings in three severities:
//   violation  a C invariant is broken (money/holds/state contradiction)        -> always fails (exit 1)
//   attention  needs a recorded human decision (attention rows, DLQ, reconcile)  -> fails in --mode quiescent
//   pending    in-flight work that will converge (outbox, saga, work, queues)    -> fails in --mode quiescent
// Exit codes: 0 ok, 1 violations, 2 not quiescent (quiescent mode only), 3 usage/connection error.
//
// The SQLite and PostgreSQL snapshots are taken separately (they are different databases), so
// live cross-service mismatches can reflect in-flight work between those snapshots.
// Freeze writers and drain/stop consumers before final quiescent cutover evidence.
import { parseArgs, isDeepStrictEqual } from "node:util";
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requireFrom = (dir) => createRequire(path.join(root, dir, "package.json"));
const Database = requireFrom("bangkok-homeservice")("better-sqlite3");
const pg = requireFrom("services/payments-wallet")("pg");

// Must match bangkok-homeservice/lib/messaging/broker-relay.js PUBLISHED_TYPES (checked by the test).
export const PUBLISHED_TYPES = ["booking.status_changed", "booking.completed", "bid.accepted", "review.created", "provider.approved", "provider.registered"];
const SAMPLE = 5;
const migrationDirectory = path.join(root, "services/payments-wallet/migrations");
const expectedMigrations = readdirSync(migrationDirectory).filter(n => /^\d+_[a-z0-9_]+\.sql$/.test(n)).sort().map(version => ({
  version, sha256: createHash("sha256").update(readFileSync(path.join(migrationDirectory, version))).digest("hex"),
}));
const PAYMENT_TABLES = ["schema_migrations", "payment_intents", "transactions", "provider_wallets", "webhook_events", "outbox_events", "payment_commands", "payment_provisioning", "processed_events", "financial_commands", "financial_fences", "legacy_payment_bindings"];

class Report {
  constructor() { this.findings = []; this.info = {}; }
  add(severity, id, rows, message, key = (r) => r.id ?? r.order_id ?? r.saga_id ?? r.operation_id ?? r.event_id) {
    const list = Array.isArray(rows) ? rows : [];
    const count = Array.isArray(rows) ? rows.length : rows;
    if (!count) return;
    this.findings.push({ severity, id, count, message, sample: list.slice(0, SAMPLE).map(key) });
  }
  count(severity) { return this.findings.filter((f) => f.severity === severity).length; }
}

// ------------------------------------------------------------------ monolith SQLite
export function checkSqlite(file, report) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const has = (table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  const s = {};
  try {
    db.exec("BEGIN"); // one read snapshot of the file
    for (const table of ["orders", "slot_holds", "events", "booking_sagas", "booking_saga_activations", "booking_financial_work", "consistency_attention"]) {
      if (!has(table)) throw new Error("SQLITE_SCHEMA_REVIEW_REQUIRED: missing " + table);
    }
    const marks = PUBLISHED_TYPES.map(() => "?").join(",");
    if (db.prepare("SELECT 1 FROM pragma_table_info('events') WHERE name='published_at'").get()) {
      report.add("pending", "sqlite.outbox.unpublished", all(`SELECT id, type FROM events WHERE published_at IS NULL AND type IN (${marks}) ORDER BY id`, ...PUBLISHED_TYPES),
        "monolith events not yet published to RabbitMQ");
    }
    if (has("booking_sagas")) {
      s.sagas = all("SELECT saga_id, order_id, state FROM booking_sagas");
      report.add("pending", "sqlite.saga.active", s.sagas.filter((r) => ["INTENT_CREATE_PENDING", "COMPENSATION_PENDING"].includes(r.state)), "provisioning sagas still running");
      report.add("attention", "sqlite.saga.recovery", s.sagas.filter((r) => r.state === "RECOVERY_PENDING"), "sagas whose compensation is unconfirmed (manual recovery)");
    }
    if (has("booking_saga_activations")) {
      const rows = all(`SELECT a.saga_id, a.state, s.state AS saga_state, s.order_id, o.status AS order_status
        FROM booking_saga_activations a JOIN booking_sagas s USING (saga_id) JOIN orders o ON o.id = s.order_id`);
      report.add("pending", "sqlite.activation.pending", rows.filter((r) => r.state === "pending"), "COMPLETED sagas whose Payments activation is not confirmed");
      report.add("attention", "sqlite.activation.reconcile", rows.filter((r) => r.state === "reconcile"), "activation conflicts awaiting reconciliation");
      report.add("attention", "sqlite.activation.blocked_open", rows.filter((r) => r.state === "blocked" && r.order_status !== "cancelled"), "activation blocked by a Payments fence but the booking is not cancelled");
      report.add("violation", "sqlite.activation.without_completed_saga", rows.filter((r) => r.state === "activated" && r.saga_state !== "COMPLETED"), "activated payment setup for a saga that is not COMPLETED");
    }
    if (has("booking_financial_work")) {
      s.work = all(`SELECT w.operation_id, w.command_id, w.request_json, w.kind, w.order_id, w.state, w.result_json, o.status AS order_status, o.payment_status
        FROM booking_financial_work w JOIN orders o ON o.id = w.order_id`);
      report.add("pending", "sqlite.financial.pending", s.work.filter((r) => r.state === "pending"), "financial completion/cancellation work not yet confirmed by Payments");
      report.add("attention", "sqlite.financial.attention", s.work.filter((r) => r.state === "attention"), "financial work needing reconciliation");
      report.add("violation", "sqlite.financial.completion_not_completed", s.work.filter((r) => r.kind === "completion" && r.order_status !== "completed"), "completion work exists but the booking is not completed");
      report.add("violation", "sqlite.financial.cancel_ready_not_cancelled", s.work.filter((r) => r.kind === "cancellation" && r.state === "ready" && r.order_status !== "cancelled"), "Payments confirmed cancellation but the booking is not cancelled");
      report.add("violation", "sqlite.financial.cancel_pending_but_cancelled", s.work.filter((r) => r.kind === "cancellation" && r.state === "pending" && r.order_status === "cancelled"), "booking cancelled before Payments confirmed the cancellation");
    }
    report.add("violation", "sqlite.holds.on_terminal_order",
      all("SELECT DISTINCT o.id FROM slot_holds h JOIN orders o ON o.id = h.order_id WHERE o.status IN ('cancelled','completed')"),
      "slot holds kept for a cancelled/completed booking");
    if (has("consistency_attention")) {
      report.add("attention", "sqlite.attention.open", all("SELECT id, consumer_name, reason FROM consistency_attention WHERE resolved_at IS NULL ORDER BY id"),
        "open consistency_attention rows (record a decision before cutover)");
    }
    s.orders = new Map(all("SELECT id, status, payment_status, payment_method FROM orders").map((r) => [r.id, r]));
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  return s;
}

// ------------------------------------------------------------------ Payments PostgreSQL
export async function checkPayments(url, report) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const q = async (sql, args) => (await client.query(sql, args)).rows;
  const p = {};
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const tables = new Set((await q("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()")).map((r) => r.table_name));
    const missing = PAYMENT_TABLES.filter(name => !tables.has(name));
    if (missing.length) throw new Error("PAYMENTS_SCHEMA_REVIEW_REQUIRED: missing " + missing.join(", "));
    const applied = await q("SELECT version, sha256 FROM schema_migrations ORDER BY version");
    if (!isDeepStrictEqual(applied, expectedMigrations)) throw new Error("PAYMENTS_SCHEMA_REVIEW_REQUIRED: migration versions/checksums differ");
    report.info.payments_migrations = applied.map(row => row.version);
    report.add("attention", "payments.legacy_bindings.pending_checkpoint", await q("SELECT order_id FROM legacy_payment_bindings ORDER BY order_id"), "legacy bindings require the future two-owner manifest/checkpoint reconciliation; schema006 alone is not cutover approval");
    if (tables.has("outbox_events")) {
      report.add("pending", "payments.outbox.unpublished", await q("SELECT event_id, event_type FROM outbox_events WHERE published_at IS NULL ORDER BY seq"), "Payments events not yet published");
    }
    if (tables.has("payment_provisioning")) {
      report.add("pending", "payments.provisioning.created", await q("SELECT order_id, create_command_id FROM payment_provisioning WHERE state = 'created'"),
        "provisioned intents not yet activated (not settleable)");
    }
    if (tables.has("financial_commands")) {
      p.commands = await q("SELECT caller_id, operation_id, order_id, kind, state, command_id, request, result FROM financial_commands");
      report.add("pending", "payments.financial.pending", p.commands.filter((r) => r.state === "pending"), "financial commands still pending (e.g. awaiting settlement)");
      report.add("attention", "payments.financial.attention", p.commands.filter((r) => r.state === "attention"), "financial commands in attention");
    }
    // Per-order money invariants (each line is one order).
    const ledger = await q(`SELECT order_id,
        count(*) FILTER (WHERE kind='charge' AND status='succeeded')::int AS charges,
        count(*) FILTER (WHERE kind='refund')::int AS refunds,
        count(*) FILTER (WHERE kind='payout_credit')::int AS payouts,
        count(*) FILTER (WHERE kind='commission_owed')::int AS commissions
      FROM transactions WHERE order_id IS NOT NULL GROUP BY order_id`);
    p.ledger = new Map(ledger.map((r) => [r.order_id, r]));
    report.add("violation", "payments.ledger.duplicate", ledger.filter((r) => r.charges > 1 || r.refunds > 1 || r.payouts > 1 || r.commissions > 1), "an order was charged, refunded or credited more than once");
    report.add("violation", "payments.ledger.refund_without_charge", ledger.filter((r) => r.refunds > 0 && r.charges === 0), "refund without a charge");
    report.add("violation", "payments.ledger.payout_and_refund", ledger.filter((r) => r.refunds > 0 && (r.payouts > 0 || r.commissions > 0)), "both completion accounting and a refund for one order");
    const intents = await q("SELECT order_id, status FROM payment_intents");
    p.intents = new Map(intents.map((r) => [r.order_id, r]));
    report.add("violation", "payments.intent.charge_mismatch",
      intents.filter((i) => (i.status === "succeeded") !== ((p.ledger.get(i.order_id)?.charges ?? 0) > 0)),
      "intent status and charge ledger disagree");
    if (tables.has("financial_fences")) {
      const fences = await q("SELECT order_id, outcome FROM financial_fences");
      p.fences = new Map(fences.map((r) => [r.order_id, r]));
      report.add("violation", "payments.fence.money_kept", fences.filter((f) => { const l = p.ledger.get(f.order_id); return l && l.charges > l.refunds; }),
        "a fenced (cancelled) order kept a charge without refund");
      report.add("violation", "payments.fence.accounted", fences.filter((f) => { const l = p.ledger.get(f.order_id); return l && (l.payouts > 0 || l.commissions > 0); }),
        "a fenced (cancelled) order has completion accounting");
      report.add("violation", "payments.fence.refund_missing", fences.filter((f) => f.outcome === "refunded" && !(p.ledger.get(f.order_id)?.refunds > 0)),
        "fence says refunded but no refund ledger row");
      report.add("violation", "payments.financial.cancel_ready_unfenced",
        (p.commands ?? []).filter((c) => c.kind === "cancellation" && c.state === "ready" && !p.fences.has(c.order_id)), "ready cancellation without an order fence");
    }
    report.add("violation", "payments.financial.completion_unaccounted",
      (p.commands ?? []).filter((c) => c.kind === "completion" && c.state === "ready" && !((p.ledger.get(c.order_id)?.payouts ?? 0) + (p.ledger.get(c.order_id)?.commissions ?? 0))),
      "ready completion without accounting ledger row");
    report.add("violation", "payments.wallet.negative", await q("SELECT provider_id AS id FROM provider_wallets WHERE balance_cents < 0 OR commission_owed_cents < 0"), "negative wallet value");
    await client.query("COMMIT");
  } finally {
    await client.end();
  }
  return p;
}

// ------------------------------------------------------------------ cross-service (Booking <-> Payments)
export function checkCross(s, p, report) {
  if (!s || !p) return;
  const byOrder = (rows) => new Map((rows ?? []).map((r) => [`${r.order_id}:${r.kind}`, r]));
  const work = byOrder(s.work);
  const commands = byOrder(p.commands);
  report.add("violation", "cross.financial.command_identity_mismatch",
    (s.work ?? []).filter(w => { const c = commands.get(`${w.order_id}:${w.kind}`); return c &&
      (w.command_id !== c.command_id || w.operation_id !== c.operation_id || !isDeepStrictEqual(JSON.parse(w.request_json), c.request)); }),
    "Booking/Payments command ID, operation ID or immutable request differs");
  report.add("violation", "cross.financial.ready_result_mismatch",
    (s.work ?? []).filter(w => { const c = commands.get(`${w.order_id}:${w.kind}`); return w.state === "ready" && c?.state === "ready" &&
      !isDeepStrictEqual(JSON.parse(w.result_json), c.result); }), "Booking/Payments ready results differ");
  // Payments holds an accepted financial command Booking does not know about (Booking lost its work).
  report.add("violation", "cross.financial.orphan_payments_command",
    (p.commands ?? []).filter((c) => !work.has(`${c.order_id}:${c.kind}`)), "Payments financial command without Booking work");
  // Booking believes Payments confirmed, Payments disagrees.
  report.add("violation", "cross.financial.ready_not_in_payments",
    (s.work ?? []).filter((w) => w.state === "ready" && commands.get(`${w.order_id}:${w.kind}`)?.state !== "ready"), "Booking work ready but Payments has no ready command");
  report.add("violation", "cross.cancel.refund_disagrees",
    (s.work ?? []).filter((w) => w.kind === "cancellation" && w.state === "ready"
      && (JSON.parse(w.result_json ?? "{}").outcome === "refunded") !== ((p.ledger.get(w.order_id)?.refunds ?? 0) > 0)),
    "Booking and Payments disagree on whether a cancelled booking was refunded");
  // Saga-owned (new-mode) gateway bookings: local paid flag must be backed by a Payments charge.
  const sagaOrders = new Set((s.sagas ?? []).map((r) => r.order_id));
  const sagaOrderRows = [...sagaOrders].map((id) => s.orders.get(id)).filter(Boolean);
  report.add("violation", "cross.paid_without_charge",
    sagaOrderRows.filter((o) => o.payment_status === "paid" && !((p.ledger.get(o.id)?.charges ?? 0) > 0)), "booking marked paid without a Payments charge");
  report.add("pending", "cross.charge_not_yet_paid",
    sagaOrderRows.filter((o) => o.status !== "cancelled" && o.payment_status === "pending" && (p.ledger.get(o.id)?.charges ?? 0) > 0),
    "Payments charged but Booking has not applied payment.succeeded yet (event in flight)");
  report.add("violation", "cross.cancelled_but_charged",
    sagaOrderRows.filter((o) => o.status === "cancelled" && (p.ledger.get(o.id)?.charges ?? 0) > (p.ledger.get(o.id)?.refunds ?? 0)
      && !(s.work ?? []).some((w) => w.order_id === o.id && w.state !== "ready")),
    "cancelled booking whose charge was not refunded (and no reconciliation work is open)");
}

// ------------------------------------------------------------------ Notifications / broker
export async function checkNotifications(url, report) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const rows = (await client.query("SELECT consumer_name, count(*)::int AS n FROM processed_events GROUP BY consumer_name")).rows;
    report.info.notifications_processed = Object.fromEntries(rows.map((r) => [r.consumer_name, r.n]));
  } finally { await client.end(); }
}

// ------------------------------------------------------------------ CLI
export async function run(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({ args: argv, options: {
    sqlite: { type: "string", default: env.C_CHECK_SQLITE },
    "payments-url": { type: "string", default: env.C_CHECK_PAYMENTS_URL },
    "notifications-url": { type: "string", default: env.C_CHECK_NOTIFICATIONS_URL },
    "amqp-url": { type: "string", default: env.C_CHECK_AMQP_URL },
    "broker-management-url": { type: "string", default: env.C_CHECK_BROKER_MANAGEMENT_URL },
    mode: { type: "string", default: "report" },
    'legacy-directory': {type:'string'},
    'manifest-sha256': {type:'string'},
    'checkpoint-file': {type:'string'},
    'checkpoint-public-key-file': {type:'string'},
    json: { type: "boolean", default: false },
  } });
  if (!["report", "quiescent"].includes(values.mode) || (!values.sqlite && !values["payments-url"]) ||
    (values.mode === "quiescent" && (!values.sqlite || !values["payments-url"])) ||
    (values["broker-management-url"] && !values["amqp-url"])) {
    return { code: 3, output: "usage: c-check.mjs --sqlite <file> --payments-url <url> [--notifications-url <url>] [--amqp-url <url> --broker-management-url <origin>] [--mode report|quiescent] [--json]" };
  }
  const report = new Report();
  try {
    const s = values.sqlite ? checkSqlite(values.sqlite, report) : null;
    const p = values["payments-url"] ? await checkPayments(values["payments-url"], report) : null;
    checkCross(s, p, report);
    if (values["notifications-url"]) await checkNotifications(values["notifications-url"], report);
    if (values["amqp-url"]) await checkBroker(values["amqp-url"], report, { managementUrl: values["broker-management-url"], mode: values.mode });
    const legacyKeys=['legacy-directory','manifest-sha256','checkpoint-file','checkpoint-public-key-file'];
    if(legacyKeys.some(k=>values[k])){
      if(!legacyKeys.every(k=>values[k])||values.mode!=='quiescent'||!values.sqlite||!values['payments-url']||!values['notifications-url']||!values['amqp-url']||!values['broker-management-url'])throw Error('complete legacy checkpoint sources required');
      // Preserve the existing standalone checker image's dependency footprint.
      // Complete legacy tooling is loaded only for an explicit checkpoint check.
      const [{loadApprovedSnapshot},{inspectCheckpoint},{readCheckpoint},{createDatabase:paymentsDatabase},{createDatabase:notificationsDatabase}]=await Promise.all([
        import('../data-migration/approved-snapshot.mjs'),import('../cutover/checkpoint.mjs'),
        import('../../services/payments-wallet/src/legacy-checkpoint.js'),
        import('../../services/payments-wallet/src/database.js'),import('../../services/notifications/src/database.js'),
      ]);
      const receipt=readCheckpoint(values['checkpoint-file'],values['checkpoint-public-key-file']);
      const approved=await loadApprovedSnapshot(values['legacy-directory'],values['manifest-sha256']);
      const sqlite=new Database(values.sqlite,{readonly:true,fileMustExist:true});
      const payments=paymentsDatabase(values['payments-url']),notifications=notificationsDatabase(values['notifications-url']);
      try{
        const state=await inspectCheckpoint({approved,bookingDb:sqlite,paymentsDatabase:payments,notificationsDatabase:notifications,broker:{amqpUrl:values['amqp-url'],managementUrl:values['broker-management-url']}});
        if(receipt.manifest_sha256!==state.manifest_sha256||receipt.snapshot_id!==state.snapshot_id||receipt.phase_digest!==state.phase_digest||sqlite.prepare('SELECT state FROM booking_legacy_payment_checkpoints WHERE manifest_sha256=?').get(state.manifest_sha256)?.state!=='approved')throw Error('checkpoint mismatch');
        report.findings=report.findings.filter(x=>x.id!=='payments.legacy_bindings.pending_checkpoint');
        report.info.legacy_checkpoint={manifest_sha256:state.manifest_sha256,snapshot_id:state.snapshot_id,state:'approved'};
      }finally{sqlite.close();await payments.close();await notifications.close();}
    }

  } catch (error) {
    return { code: 3, output: `c-check: could not read a source (${error?.code ?? error?.name ?? "error"}: ${error?.message ?? error})` };
  }
  const violations = report.count("violation");
  const unsettled = report.count("pending") + report.count("attention");
  const code = violations ? 1 : values.mode === "quiescent" && unsettled ? 2 : 0;
  const summary = { mode: values.mode, ok: code === 0, violations, attention: report.count("attention"), pending: report.count("pending"),
    sources: { sqlite: !!values.sqlite, payments: !!values["payments-url"], notifications: !!values["notifications-url"], broker: !!values["amqp-url"] },
    findings: report.findings, info: report.info };
  const output = values.json ? JSON.stringify(summary, null, 2) : [
    `C consistency check (${values.mode}): ${summary.ok ? "OK" : "NOT OK"} — ${violations} violation(s), ${summary.attention} attention, ${summary.pending} pending`,
    ...report.findings.map((f) => `  [${f.severity}] ${f.id} ×${f.count}: ${f.message}${f.sample.length ? ` (e.g. ${f.sample.join(", ")})` : ""}`),
  ].join("\n");
  return { code, output, summary };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, output } = await run();
  (code === 3 ? console.error : console.log)(output);
  process.exitCode = code;
}
