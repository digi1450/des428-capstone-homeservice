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

// Fingerprint of the schema on main at b4d0b46 (before this upgrade), computed by A's migrate().
const MAIN_B4D0B46 = "6c9ccb3f5661b3222617abf0e77f409d918ea6f2c7de2ca54fcdc7188ad1788d";

const rows = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('app_schema_version','booking_saga_activations') ORDER BY name").all()
  .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]);

function withOldDatabase(run, { marker = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "homeservice-upgrade-"));
  const db = new Database(join(directory, "old.sqlite"));
  try {
    migrate(db);
    // Turn it into exactly the previous schema/marker, then add data the old app could have written.
    db.exec("DROP INDEX idx_booking_saga_activations_due; DROP TABLE booking_saga_activations");
    db.prepare("UPDATE app_schema_version SET fingerprint = ?").run(PREVIOUS_FINGERPRINTS[0]);
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
  assert.deepEqual(PREVIOUS_FINGERPRINTS, [MAIN_B4D0B46]);
});

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
