// Area C: read-only consistency checker (tools/consistency/c-check.mjs).
// Builds a real monolith SQLite file (A's migrate + seed), a real Payments PostgreSQL schema and
// optionally real RabbitMQ queues, injects one contradiction at a time and checks that the CLI
// reports it with the right severity and exit code, and that it never writes.
// Opt-in, DISPOSABLE services only: TEST_PAYMENTS_DATABASE_URL (+ optional TEST_AMQP_URL).
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "../../bangkok-homeservice/node_modules/better-sqlite3/lib/index.js";
import { migrate as migrateSqlite } from "../../bangkok-homeservice/lib/db/migrate.js";
import { seed } from "../../bangkok-homeservice/lib/db/seed.js";
import { PUBLISHED_TYPES as RELAY_TYPES } from "../../bangkok-homeservice/lib/messaging/broker-relay.js";
import { createDatabase } from "../../services/payments-wallet/src/database.js";
import { migrate as migratePayments } from "../../services/payments-wallet/src/migrations.js";
import amqp from "../../services/payments-wallet/node_modules/amqplib/channel_api.js";
import { PUBLISHED_TYPES } from "../../tools/consistency/c-check.mjs";

const exec = promisify(execFile);
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../tools/consistency/c-check.mjs");
const pgUrl = process.env.TEST_PAYMENTS_DATABASE_URL;
const amqpUrl = process.env.TEST_AMQP_URL;

test("checker's published event types match the monolith relay", () => {
  assert.deepEqual([...PUBLISHED_TYPES].sort(), [...RELAY_TYPES].sort());
});

test("C consistency checker", { skip: !pgUrl }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "c-check-"));
  const file = join(dir, "booking.sqlite");
  const setup = new Database(file);
  migrateSqlite(setup, { initialize: seed });
  setup.prepare("UPDATE events SET published_at = 'seed'").run(); // seed events are not in flight
  setup.close();
  const sql = (fn) => { const db = new Database(file); try { return fn(db); } finally { db.close(); } };
  const pgdb = createDatabase(pgUrl);
  await migratePayments(pgdb);
  t.after(async () => { await pgdb.close(); rmSync(dir, { recursive: true, force: true }); });

  const cli = async (...extra) => {
    try {
      const { stdout } = await exec(process.execPath, [CLI, "--sqlite", file, "--payments-url", pgUrl, "--json", ...extra]);
      return { code: 0, ...JSON.parse(stdout) };
    } catch (error) {
      if (error.code === 3) return { code: 3, stderr: error.stderr };
      return { code: error.code, ...JSON.parse(error.stdout) };
    }
  };
  const ids = (r) => r.findings.map((f) => `${f.severity}:${f.id}`);
  const customer = sql((db) => db.prepare("SELECT id FROM customers ORDER BY id LIMIT 1").get().id);
  const provider = sql((db) => db.prepare("SELECT id FROM providers ORDER BY id LIMIT 1").get().id);
  let day = 0;
  const order = (db, { status = "confirmed", method = "gateway", payment = "pending" } = {}) => {
    day += 1;
    return db.prepare(`INSERT INTO orders (customer_id,provider_id,service_date,starting_time,ending_time,duration_min,subtotal_cents,tax_cents,total_cents,commission_pct,payment_method,payment_status,otp,status)
      VALUES (?,?,?,'10:00','10:30',30,10000,700,10700,10,?,?,123456,?)`).run(customer, provider, `2027-05-${String(day).padStart(2, "0")}`, method, payment, status).lastInsertRowid;
  };
  const saga = (db, orderId) => db.prepare(`INSERT INTO booking_sagas (saga_id,order_id,customer_id,request_key,request_digest,state,create_command_id,cancel_command_id,snapshot_json,intent_json)
    VALUES (?,?,?,?,'d','COMPLETED',?,?,'{}','{}')`).run(`saga-${orderId}`, orderId, customer, `k-${orderId}`, `create:saga-${orderId}`, `cancel:saga-${orderId}`);
  const work = (db, orderId, kind, state, result = null) => {
    const op = randomUUID();
    db.prepare(`INSERT INTO booking_financial_work (operation_id,kind,order_id,command_id,request_json,state,result_json) VALUES (?,?,?,?,'{}',?,?)`)
      .run(op, kind, orderId, `${kind === "completion" ? "complete" : "cancel"}:${op}`, state, result ? JSON.stringify(result) : null);
    return op;
  };
  const ledgerRow = (orderId, kind) => pgdb.query(`INSERT INTO transactions (kind, order_id, customer_id, provider_id, amount_cents, method, status)
    VALUES ($1,$2,$3,$4,10700,'gateway','succeeded')`, [kind, orderId, customer, provider]);
  const sha = () => createHash("sha256").update(readFileSync(file)).digest("hex");

  await t.test("clean state: OK in both modes, read-only (file bytes and mtime unchanged)", async () => {
    const before = { hash: sha(), mtime: statSync(file).mtimeMs };
    const report = await cli();
    assert.equal(report.code, 0, JSON.stringify(report.findings));
    assert.equal((await cli("--mode", "quiescent")).code, 0);
    assert.deepEqual({ hash: sha(), mtime: statSync(file).mtimeMs }, before);
  });

  await t.test("in-flight work is pending: OK in report mode, exit 2 in quiescent mode", async () => {
    const op = sql((db) => {
      db.prepare("INSERT INTO events (type,aggregate_type,aggregate_id,payload_json,event_uuid) VALUES ('provider.registered','provider',1,'{}',?)").run(randomUUID());
      const id = order(db, { status: "awaiting" });
      saga(db, id);
      return work(db, id, "cancellation", "pending");
    });
    const report = await cli();
    assert.equal(report.code, 0);
    assert.ok(ids(report).includes("pending:sqlite.outbox.unpublished"));
    assert.ok(ids(report).includes("pending:sqlite.financial.pending"));
    assert.equal((await cli("--mode", "quiescent")).code, 2);
    sql((db) => {
      db.prepare("UPDATE events SET published_at = 'test' WHERE published_at IS NULL").run();
      db.prepare("DELETE FROM booking_financial_work WHERE operation_id = ?").run(op);
    });
  });

  await t.test("open attention rows fail quiescent mode until resolved", async () => {
    sql((db) => db.prepare("INSERT INTO consistency_attention (consumer_name,event_id,event_type,aggregate_id,reason) VALUES ('booking-finalization','x','financial.cancellation','1','probe')").run());
    const report = await cli("--mode", "quiescent");
    assert.equal(report.code, 2);
    assert.ok(ids(report).includes("attention:sqlite.attention.open"));
    sql((db) => db.prepare("UPDATE consistency_attention SET resolved_at = 'reviewed' WHERE resolved_at IS NULL").run());
    assert.equal((await cli("--mode", "quiescent")).code, 0);
  });

  await t.test("violations fail in any mode (one injected at a time)", async () => {
    const cases = [
      ["sqlite.holds.on_terminal_order", async () => sql((db) => {
        const id = order(db, { status: "cancelled" });
        db.prepare("INSERT INTO slot_holds (provider_id, service_date, slot_time, order_id) VALUES (?,?,?,?)").run(provider, "2027-06-01", "10:00", id);
        return () => sql((d) => d.prepare("DELETE FROM slot_holds WHERE order_id = ?").run(id));
      })],
      ["sqlite.financial.cancel_ready_not_cancelled", async () => sql((db) => {
        const op = work(db, order(db, { status: "confirmed", method: "cod" }), "cancellation", "ready", { outcome: "no_payment" });
        return () => sql((d) => d.prepare("DELETE FROM booking_financial_work WHERE operation_id = ?").run(op));
      })],
      ["payments.ledger.payout_and_refund", async () => {
        const id = 900001;
        await ledgerRow(id, "charge"); await ledgerRow(id, "refund"); await ledgerRow(id, "payout_credit");
        return () => pgdb.query("DELETE FROM transactions WHERE order_id = $1", [id]);
      }],
      ["cross.paid_without_charge", async () => sql((db) => {
        const id = order(db, { payment: "paid" }); saga(db, id);
        return () => sql((d) => { d.prepare("DELETE FROM booking_sagas WHERE order_id = ?").run(id); d.prepare("UPDATE orders SET payment_status='pending' WHERE id = ?").run(id); });
      })],
      ["cross.cancel.refund_disagrees", async () => sql((db) => {
        const id = order(db, { status: "cancelled", payment: "refunded" }); saga(db, id);
        const op = work(db, id, "cancellation", "ready", { outcome: "refunded" });
        return () => sql((d) => { d.prepare("DELETE FROM booking_financial_work WHERE operation_id = ?").run(op); d.prepare("DELETE FROM booking_sagas WHERE order_id = ?").run(id); });
      })],
    ];
    for (const [expected, inject] of cases) {
      const undo = await inject();
      const report = await cli();
      assert.equal(report.code, 1, expected);
      assert.ok(ids(report).includes(`violation:${expected}`), `${expected}: ${ids(report)}`);
      await undo();
    }
    // The ready cancellation above has no Payments command; after cleanup the state is clean again.
    const clean = await cli();
    assert.equal(clean.code, 0, JSON.stringify(clean.findings));
  });

  await t.test("broker: undelivered messages are pending, dead letters are attention", { skip: !amqpUrl }, async () => {
    const connection = await amqp.connect(amqpUrl);
    const ch = await connection.createChannel();
    try {
      for (const q of ["booking.events", "ratings.events", "notifications.events", "payments.events"]) {
        await ch.assertQueue(`${q}.dlq`, { durable: true, arguments: { "x-queue-type": "quorum" } });
        await ch.purgeQueue(`${q}.dlq`);
      }
      const before = await cli("--amqp-url", amqpUrl);
      assert.ok(!ids(before).some((id) => id.startsWith("attention:broker.dlq")));
      ch.sendToQueue("payments.events.dlq", Buffer.from("{}"));
      await new Promise((r) => setTimeout(r, 200));
      const report = await cli("--amqp-url", amqpUrl, "--mode", "quiescent");
      assert.equal(report.code, 2);
      assert.ok(ids(report).includes("attention:broker.dlq.payments.events.dlq"));
      await ch.purgeQueue("payments.events.dlq");
    } finally { await ch.close(); await connection.close(); }
  });

  await t.test("unreachable source is a usage/connection error (exit 3), not a pass", async () => {
    const report = await (async () => {
      try { await exec(process.execPath, [CLI, "--sqlite", join(dir, "missing.sqlite")]); return { code: 0 }; }
      catch (error) { return { code: error.code }; }
    })();
    assert.equal(report.code, 3);
  });
});
