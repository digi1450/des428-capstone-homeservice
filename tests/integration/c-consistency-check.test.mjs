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
const managementUrl = process.env.TEST_BROKER_MANAGEMENT_URL;

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
    if (extra.includes("--amqp-url") && !extra.includes("--broker-management-url") && managementUrl) extra.push("--broker-management-url",managementUrl);
    try {
      const { stdout } = await exec(process.execPath, [CLI, "--sqlite", file, "--payments-url", pgUrl, "--json", ...extra]);
      return { code: 0, ...JSON.parse(stdout) };
    } catch (error) {
      if (error.code === 3) return { code: 3, stderr: error.stderr };
      return { code: error.code, ...JSON.parse(error.stdout) };
    }
  };
  const observed = async (args, predicate) => {
    for (let n=0;n<80;n++) { const report=await cli(...args);if(predicate(report))return report;await new Promise(r=>setTimeout(r,250)); }
    throw Error("broker statistics did not reach the asserted state");
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

  await t.test("completed booking occupancy remains valid even for a future service date", async () => {
    const id=sql(db=>{const id=order(db,{status:'completed',method:'cod'});db.prepare('INSERT INTO slot_holds(provider_id,service_date,slot_time,order_id) VALUES (?,?,?,?)').run(provider,'2027-06-02','10:00',id);return id;});
    try{const before={hash:sha(),mtime:statSync(file).mtimeMs};const report=await cli('--mode','quiescent');assert.equal(report.code,0,JSON.stringify(report.findings));assert.ok(!ids(report).includes('violation:sqlite.holds.on_terminal_order'));assert.deepEqual({hash:sha(),mtime:statSync(file).mtimeMs},before);}
    finally{sql(db=>{db.prepare('DELETE FROM slot_holds WHERE order_id=?').run(id);db.prepare('DELETE FROM orders WHERE id=?').run(id);});}
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
    const ch = await connection.createConfirmChannel();
    try {
      for (const q of ["booking.events", "ratings.events", "notifications.events", "payments.events"]) {
        await ch.assertQueue(q, { durable: true, arguments: { "x-queue-type": "quorum" } });
        await ch.assertQueue(`${q}.dlq`, { durable: true, arguments: { "x-queue-type": "quorum" } });
        await ch.purgeQueue(`${q}.dlq`);
      }
      const before = await observed(["--amqp-url",amqpUrl], r=>r.code!==3);
      assert.ok(!ids(before).some((id) => id.startsWith("attention:broker.dlq")));
      ch.sendToQueue("payments.events.dlq", Buffer.from("{}"));
      await ch.waitForConfirms();
      const report = await observed(["--amqp-url",amqpUrl,"--mode","quiescent"],
        r=>r.code===2&&ids(r).includes("attention:broker.dlq.payments.events.dlq"));
      assert.equal(report.code, 2);
      assert.ok(ids(report).includes("attention:broker.dlq.payments.events.dlq"));
      await ch.purgeQueue("payments.events.dlq");
    } finally { await ch.close(); await connection.close(); }
  });

  await t.test("missing/partial schemas and changed migration checksums never pass", async () => {
    await pgdb.query('ALTER TABLE financial_fences RENAME TO hidden_financial_fences');
    try { assert.equal((await cli('--mode','quiescent')).code,3); }
    finally { await pgdb.query('ALTER TABLE hidden_financial_fences RENAME TO financial_fences'); }
    const original=(await pgdb.query('SELECT version,sha256 FROM schema_migrations ORDER BY version LIMIT 1')).rows[0];
    await pgdb.query("UPDATE schema_migrations SET sha256='changed' WHERE version=$1",[original.version]);
    try { assert.equal((await cli()).code,3); }
    finally { await pgdb.query('UPDATE schema_migrations SET sha256=$2 WHERE version=$1',[original.version,original.sha256]); }
    sql(db=>db.exec('ALTER TABLE booking_financial_work RENAME TO hidden_work'));
    try { assert.equal((await cli()).code,3); }
    finally { sql(db=>db.exec('ALTER TABLE hidden_work RENAME TO booking_financial_work')); }
    assert.equal((await cli('--mode','quiescent')).code,0);
  });

  await t.test("ready commands require matching keys, operation, immutable request and result", async () => {
    const id=sql(db=>order(db,{status:'completed',method:'cod'}));
    const operation=sql(db=>work(db,id,'completion','ready'));
    const command='complete:'+operation;
    const request={operation_id:operation,order_id:Number(id),customer_id:customer,provider_id:provider,payment_method:'cod',amount_cents:10700,currency:'THB',commission_cents:1070};
    const result={state:'ready',kind:'completion',command_id:command,request,outcome:'accounted'};
    sql(db=>db.prepare('UPDATE booking_financial_work SET request_json=?,result_json=? WHERE operation_id=?').run(JSON.stringify(request),JSON.stringify(result),operation));
    await pgdb.query(`INSERT INTO financial_commands(caller_id,command_id,kind,operation_id,order_id,request_digest,request,state,result)
      VALUES ('review-booking',$1,'completion',$2,$3,'fixture',$4,'ready',$5)`,[command,operation,id,request,result]);
    await pgdb.query("INSERT INTO transactions(kind,order_id,customer_id,provider_id,amount_cents,method,status) VALUES ('commission_owed',$1,$2,$3,1070,'cod','succeeded')",[id,customer,provider]);
    try {
      assert.equal((await cli('--mode','quiescent')).code,0,'matching saved command is accepted');
      const other=randomUUID();
      await pgdb.query('UPDATE financial_commands SET operation_id=$2,command_id=$3 WHERE order_id=$1',[id,other,'complete:'+other]);
      const keys=await cli();assert.equal(keys.code,1);assert.ok(ids(keys).includes('violation:cross.financial.command_identity_mismatch'));
      await pgdb.query('UPDATE financial_commands SET operation_id=$2,command_id=$3 WHERE order_id=$1',[id,operation,command]);
      await pgdb.query('UPDATE financial_commands SET request=$2 WHERE order_id=$1',[id,{...request,amount_cents:99999}]);
      assert.ok(ids(await cli()).includes('violation:cross.financial.command_identity_mismatch'));
      await pgdb.query('UPDATE financial_commands SET request=$2,result=$3 WHERE order_id=$1',[id,request,{...result,outcome:'changed'}]);
      assert.ok(ids(await cli()).includes('violation:cross.financial.ready_result_mismatch'));
      await pgdb.query('UPDATE financial_commands SET result=$2 WHERE order_id=$1',[id,result]);
      assert.equal((await cli('--mode','quiescent')).code,0);
    } finally {
      await pgdb.query('DELETE FROM financial_commands WHERE order_id=$1',[id]);
      await pgdb.query('DELETE FROM transactions WHERE order_id=$1',[id]);
      sql(db=>db.prepare('DELETE FROM booking_financial_work WHERE operation_id=?').run(operation));
    }
  });

  await t.test("unacked deliveries, missing counters/queues and management failures never pass", {skip:!amqpUrl||!managementUrl}, async () => {
    const connection=await amqp.connect(amqpUrl),ch=await connection.createConfirmChannel();
    const until=async(predicate)=>{for(let n=0;n<80;n++){if(await predicate())return;await new Promise(r=>setTimeout(r,250));}throw Error('broker statistics deadline');};
    const broker=new URL(amqpUrl),auth='Basic '+Buffer.from(decodeURIComponent(broker.username)+':'+decodeURIComponent(broker.password)).toString('base64');
    const vhost=decodeURIComponent(broker.pathname.slice(1))||'/';
    const stats=async q=>{const r=await fetch(new URL('/api/queues/'+encodeURIComponent(vhost)+'/'+encodeURIComponent(q),managementUrl),{headers:{Authorization:auth}});return r.json();};
    const brokerArgs=['--amqp-url',amqpUrl,'--mode','quiescent'];
    try {
      for(const name of ['booking.events','ratings.events','notifications.events','payments.events']){
        await ch.assertQueue(name,{durable:true,arguments:{'x-queue-type':'quorum'}});
        await ch.assertQueue(name+'.dlq',{durable:true,arguments:{'x-queue-type':'quorum'}});
      }
      await until(async()=>{const r=await cli(...brokerArgs);return r.code===0;});
      ch.sendToQueue('booking.events',Buffer.from('{"probe":"real-unacked"}'));await ch.waitForConfirms();
      let received;const delivery=new Promise(resolve=>{received=resolve;});
      const {consumerTag}=await ch.consume('booking.events',message=>received(message),{noAck:false});
      const message=await delivery;assert.ok(message);
      await until(async()=>((await stats('booking.events')).messages_unacknowledged===1));
      const report=await cli(...brokerArgs);assert.equal(report.code,2);assert.equal(report.info.queues['booking.events'].messages,0);
      assert.equal(report.info.queues['booking.events'].unacknowledged,1);assert.ok(ids(report).includes('pending:broker.queue.booking.events'));
      ch.ack(message);
      await until(async()=>((await stats('booking.events')).messages_unacknowledged===0));
      const attached=await cli(...brokerArgs);assert.equal(attached.code,2);assert.ok(ids(attached).includes('pending:broker.consumers.booking.events'));
      await ch.cancel(consumerTag);
      await until(async()=>{const r=await cli(...brokerArgs);return r.code===0;});
      const unknown=await cli(...brokerArgs,'--broker-management-url','');assert.equal(unknown.code,2);assert.ok(ids(unknown).includes('attention:broker.unacknowledged.unknown'));
      const unavailable=new URL(managementUrl);unavailable.port='1';
      assert.equal((await cli(...brokerArgs,'--broker-management-url',unavailable.origin)).code,3);
      await ch.deleteQueue('payments.events.dlq');
      const missing=await cli(...brokerArgs);assert.equal(missing.code,2);assert.ok(ids(missing).includes('attention:broker.queue.missing'));
      await ch.assertQueue('payments.events.dlq',{durable:true,arguments:{'x-queue-type':'quorum'}});
    }finally{await ch.close();await connection.close();}
  });

  await t.test("unreachable source is a usage/connection error (exit 3), not a pass", async () => {
    const report = await (async () => {
      try { await exec(process.execPath, [CLI, "--sqlite", join(dir, "missing.sqlite")]); return { code: 0 }; }
      catch (error) { return { code: error.code }; }
    })();
    assert.equal(report.code, 3);
  });
});
