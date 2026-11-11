// Area C: reviewed additive upgrade on top of A's persistent-startup guard (#23).
// A database written by the previous schema (main before booking_saga_activations) is upgraded
// atomically, keeps every row, backfills activation work for already COMPLETED gateway sagas,
// and anything else still fails closed.
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, PREVIOUS_FINGERPRINTS } from "../lib/db/migrate.js";

// Fingerprints computed by A's migrate() on real main commits:
//   b4d0b46 (before activation) and a23b98e (activation merged, before booking_financial_work).
const MAIN_B4D0B46 = "6c9ccb3f5661b3222617abf0e77f409d918ea6f2c7de2ca54fcdc7188ad1788d";
const MAIN_A23B98E = "7bce7dfae0448df028f3f4f642d78adc0e9257c529a3c193c81ed7360e7d82cf";
const MAIN_9AD496A = "6a323e7e3610be0b37cc4f69353b38b2f4ccfee9d0695ffb4759d83c870bb21d";
const MAIN_8494AA2 = "563012fa4064904c7007c7bbdc8bad063e922468702a285fd597793f445a0ee2";
const STEP_OBJECTS = [
  "DROP INDEX idx_booking_financial_work_due; DROP TABLE booking_financial_work",   // step 2
  "DROP INDEX idx_booking_saga_activations_due; DROP TABLE booking_saga_activations", // step 1
];

const rows = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('app_schema_version','booking_saga_activations','booking_financial_work','event_trace_context','booking_work_trace_context','booking_legacy_payment_bindings','booking_legacy_payment_checkpoints') ORDER BY name").all()
  .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]);

// from = 0: the b4d0b46 schema (both steps missing); from = 1: the a23b98e schema (step 2 missing).
function withOldDatabase(run, { marker = true, from = 0 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "homeservice-upgrade-"));
  const db = new Database(join(directory, "old.sqlite"));
  try {
    migrate(db);
    db.exec('DROP TABLE booking_legacy_payment_bindings; DROP TABLE booking_legacy_payment_checkpoints');
    db.exec('DROP TABLE booking_work_trace_context');
    if(from<3)db.exec('DROP TABLE event_trace_context');
    // Turn it into exactly the previous schema/marker, then add data the old app could have written.
    for (const sql of STEP_OBJECTS.slice(0, Math.max(0,STEP_OBJECTS.length - from))) db.exec(sql);
    db.prepare("UPDATE app_schema_version SET fingerprint = ?").run(PREVIOUS_FINGERPRINTS[from]);
    if (!marker) db.exec("DROP TABLE app_schema_version");
    db.exec(`
      INSERT INTO customers (id, name, email, password_hash) VALUES (1, 'c', 'c@example.com', 'x');
      INSERT INTO providers (id, name, email, password_hash) VALUES (1, 'p', 'p@example.com', 'x');`);
    const order = (n) => db.prepare(`INSERT INTO orders (customer_id,provider_id,service_date,starting_time,ending_time,duration_min,subtotal_cents,tax_cents,total_cents,commission_pct,payment_method,otp)
      VALUES (1,1,'2026-11-20','1${n}:00','1${n}:30',30,10000,700,10700,10,'gateway',1234)`).run().lastInsertRowid;
    const insertSaga = db.prepare(`INSERT INTO booking_sagas (saga_id,order_id,customer_id,request_key,request_digest,state,create_command_id,cancel_command_id,snapshot_json,intent_json)
      VALUES (?,?,1,?,'d',?,?,?,'{}',?)`);
    insertSaga.run("saga-done", order(0), "k0", "COMPLETED", "create:saga-done", "cancel:saga-done", '{"id":7}');
    insertSaga.run("saga-cod", order(1), "k1", "COMPLETED", "create:saga-cod", "cancel:saga-cod", null);
    insertSaga.run("saga-open", order(2), "k2", "INTENT_CREATE_PENDING", "create:saga-open", "cancel:saga-open", null);
    db.exec(`INSERT INTO events (type,aggregate_type,aggregate_id,payload_json,event_uuid) VALUES ('booking.status_changed','order',1,'{}','u-1');
      INSERT INTO processed_events (consumer_name,event_id,event_type,producer,outcome) VALUES ('booking','e-1','payment.succeeded','payments-wallet','applied');`);
    return run(db);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the previous fingerprint is exactly main's, so real old files are recognised", () => {
  assert.deepEqual(PREVIOUS_FINGERPRINTS, [MAIN_B4D0B46, MAIN_A23B98E,MAIN_9AD496A,MAIN_8494AA2,"c8bc03044e824076c84e6c1b99343ec7512f084dc4a02329c538b4bca2f2d846"]);
});
test('Task5 main gains only an empty recovery carrier table without changing durable work',()=>withOldDatabase(db=>{
 const orderId=db.prepare('SELECT id FROM orders ORDER BY id LIMIT 1').get().id;
 db.prepare("INSERT INTO booking_financial_work (operation_id,kind,order_id,command_id,request_json,state,attempts,next_attempt_at,locked_by,locked_until) VALUES ('saved-work','cancellation',?,'cancel:saved-work','{\"saved\":true}','pending',4,'2027-03-01','old-worker','2027-03-02')").run(orderId);
 db.prepare("INSERT INTO event_trace_context (event_id,headers_json) VALUES (1,'{\"x-request-id\":\"existing\"}')").run();
 const before=rows(db);const work=db.prepare('SELECT * FROM booking_financial_work').all();
 const eventContext=db.prepare('SELECT * FROM event_trace_context').all();assert.equal(work.length,1);
 assert.equal(migrate(db),'upgraded');assert.deepEqual(rows(db),before);assert.deepEqual(db.prepare('SELECT * FROM booking_financial_work').all(),work);
 assert.deepEqual(db.prepare('SELECT * FROM event_trace_context').all(),eventContext);
 assert.equal(db.prepare('SELECT count(*) n FROM booking_work_trace_context').get().n,0);assert.equal(migrate(db),'preserved');
},{from:3}));

test('Task4 main upgrades with every row and publication state preserved, and no invented historical context',()=>withOldDatabase(db=>{
 db.exec("UPDATE events SET publish_attempts=3,published_at='2026-11-10T00:00:00Z'");
 const before=rows(db);assert.equal(migrate(db),'upgraded');assert.deepEqual(rows(db),before);
 assert.equal(db.prepare('SELECT count(*) n FROM event_trace_context').get().n,0);
 assert.equal(migrate(db),'preserved');
},{from:2}));

test("current-main database (activation present) gets only booking_financial_work, empty, rows preserved", () => withOldDatabase((db) => {
  db.exec("INSERT INTO booking_saga_activations (saga_id, activate_command_id, state) VALUES ('saga-done', 'activate:saga-done', 'activated')");
  const before = rows(db);
  const activations = db.prepare("SELECT * FROM booking_saga_activations").all();
  assert.equal(migrate(db), "upgraded");
  assert.deepEqual(rows(db), before);
  assert.deepEqual(db.prepare("SELECT * FROM booking_saga_activations").all(), activations, "step 1 data untouched");
  assert.equal(db.prepare("SELECT count(*) AS n FROM booking_financial_work").get().n, 0, "legacy history is never replayed as new financial work");
  assert.equal(migrate(db), "preserved");
}, { from: 1 }));

test("old versioned database is upgraded atomically, rows preserved, activation backfilled", () => withOldDatabase((db) => {
  const before = rows(db);
  assert.equal(migrate(db), "upgraded");
  assert.deepEqual(rows(db), before, "no existing row changed");
  assert.deepEqual(db.prepare("SELECT saga_id, activate_command_id, state FROM booking_saga_activations").all(),
    [{ saga_id: "saga-done", activate_command_id: "activate:saga-done", state: "pending" }],
    "only COMPLETED sagas with an intent need activation");
  const fresh = new Database(":memory:");
  migrate(fresh);
  assert.deepEqual(db.prepare("SELECT fingerprint FROM app_schema_version").get(), fresh.prepare("SELECT fingerprint FROM app_schema_version").get());
  fresh.close();
  assert.equal(migrate(db), "preserved", "a second start is a no-op");
}));

test("old unversioned database is upgraded and gets the current marker", () => withOldDatabase((db) => {
  const before = rows(db);
  assert.equal(migrate(db), "upgraded");
  assert.deepEqual(rows(db), before);
  assert.equal(db.prepare("SELECT count(*) AS n FROM booking_saga_activations").get().n, 1);
  assert.equal(migrate(db), "preserved");
}, { marker: false }));

test("old schema with an unknown marker, or an extra object, still fails closed and changes nothing", () => {
  for (const tamper of [
    (db) => db.prepare("UPDATE app_schema_version SET fingerprint = 'unknown'").run(),
    (db) => db.exec("CREATE TABLE unknown_data (v TEXT)"),
    (db) => db.exec("DROP INDEX idx_orders_status"),
  ]) {
    withOldDatabase((db) => {
      tamper(db);
      const before = rows(db);
      assert.throws(() => migrate(db), /SQLITE_SCHEMA_MISMATCH/);
      assert.deepEqual(rows(db), before);
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'booking_saga_activations'").get().n, 0, "rolled back");
    });
  }
});

test("a failing backfill rolls the whole upgrade back (no table, old marker kept)", () => withOldDatabase((db) => {
  const before = rows(db);
  const failing = new Proxy(db, { get(target, prop) {
    if (prop === "exec") return (sql) => {
      if (sql.startsWith("INSERT INTO booking_saga_activations")) throw new Error("simulated backfill failure");
      return target.exec(sql);
    };
    const value = target[prop];
    return typeof value === "function" ? value.bind(target) : value;
  } });
  assert.throws(() => migrate(failing), /simulated backfill failure/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'booking_saga_activations'").get().n, 0);
  assert.equal(db.prepare("SELECT fingerprint FROM app_schema_version").get().fingerprint, PREVIOUS_FINGERPRINTS[0]);
  assert.deepEqual(rows(db), before);
  assert.equal(migrate(db), "upgraded", "the next start retries the same upgrade");
}));
