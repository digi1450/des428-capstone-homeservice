import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { migrate } from "../lib/db/migrate.js";

const snapshot = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
  .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]);
const fixture = `
 const customer = db.prepare("SELECT id FROM customers ORDER BY id LIMIT 1").get().id;
 const provider = db.prepare("SELECT id FROM providers ORDER BY id LIMIT 1").get().id;
 db.prepare("UPDATE customers SET name='persisted customer' WHERE id=?").run(customer);
 const order = db.prepare(\`INSERT INTO orders (customer_id,provider_id,service_date,starting_time,ending_time,duration_min,subtotal_cents,tax_cents,total_cents,commission_pct,payment_method,otp) VALUES (?,?,'2026-11-08','10:00','10:30',30,10000,700,10700,10,'gateway',1234)\`).run(customer,provider).lastInsertRowid;
 db.prepare("INSERT INTO slot_holds (provider_id,service_date,slot_time,order_id) VALUES (?,'2026-11-08','10:00',?)").run(provider,order);
 db.prepare(\`INSERT INTO booking_sagas (saga_id,order_id,customer_id,request_key,request_digest,state,create_command_id,cancel_command_id,snapshot_json) VALUES ('saga-persist',?,?,'request-persist','digest','INTENT_CREATE_PENDING','create-persist','cancel-persist','{}')\`).run(order,customer);
 db.exec(\`INSERT INTO booking_saga_transitions (saga_id,to_state) VALUES ('saga-persist','INTENT_CREATE_PENDING');
 INSERT INTO events (type,aggregate_type,aggregate_id,payload_json,event_uuid,publish_attempts,publish_locked_by,publish_locked_until) VALUES ('booking.created','order',1,'{}','persist-event',2,'worker','2099-01-01');
 INSERT INTO processed_events (consumer_name,event_id,event_type,producer,outcome) VALUES ('booking','received-event','payment.succeeded','payments-wallet','applied');
 INSERT INTO idempotency_keys (key,endpoint,response_json,status_code) VALUES ('persist-key','/booking','{}',201);\`);
`;
function child(path, code, { env = {}, asynchronous = false } = {}) {
  const args = ["--input-type=module", "-e", `import { bootstrapDb } from './lib/db/bootstrap.js';
    import { closeDb } from './lib/db/index.js'; ${code}`];
  const options = { env: { ...process.env, NODE_ENV: "production", DB_PATH: path, LOG_LEVEL: "silent", BCRYPT_ROUNDS: "4", ...env }, encoding: "utf8" };
  if (asynchronous) return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, args, options);
    let error = "";
    process.stderr.on("data", (chunk) => { error += chunk; });
    process.on("error", reject);
    process.on("close", (status) => status === 0 ? resolve() : reject(new Error(error)));
  });
  const result = spawnSync(process.execPath, args, options);
  assert.equal(result.status, 0, result.stderr);
}
function temporary(run) {
  const directory = mkdtempSync(join(tmpdir(), "homeservice-startup-"));
  const path = join(directory, "test.sqlite");
  try { return run(path); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("file database survives real process restarts with booking, slots, saga, outbox, dedupe and keys unchanged", () => temporary((path) => {
  child(path, `const db=bootstrapDb(); ${fixture} closeDb();`);
  let db = new Database(path);
  const before = snapshot(db);
  db.close();
  child(path, "bootstrapDb(); bootstrapDb(); closeDb();");
  db = new Database(path);
  assert.deepEqual(snapshot(db), before);
  db.close();
}));

test("current unversioned legacy database is adopted without seeding any row", () => temporary((path) => {
  child(path, `const db=bootstrapDb(); ${fixture} db.exec('DROP TABLE app_schema_version'); closeDb();`);
  let db = new Database(path);
  const before = snapshot(db);
  db.close();
  child(path, "bootstrapDb(); closeDb();");
  db = new Database(path);
  assert.deepEqual(snapshot(db).filter(([name]) => name !== "app_schema_version"), before);
  assert.equal(db.prepare("SELECT count(*) AS n FROM app_schema_version").get().n, 1);
  db.close();
}));

test("empty initialization is atomic if seed fails", () => {
  const db = new Database(":memory:");
  assert.throws(() => migrate(db, { initialize() { throw new Error("seed failure"); } }), /seed failure/);
  assert.deepEqual(snapshot(db), []);
  assert.equal(migrate(db), "initialized");
  db.close();
});

test("unknown, partial, changed-index and invalid-version schemas fail closed without changing rows", () => {
  for (const change of [
    (db) => db.exec("CREATE TABLE unknown_data (value TEXT); INSERT INTO unknown_data VALUES ('keep me')"),
    (db) => db.exec("DROP TABLE booking_saga_transitions"),
    (db) => db.exec("DROP INDEX idx_orders_status"),
    (db) => db.exec("UPDATE app_schema_version SET fingerprint='unknown'"),
    (db) => db.exec("DELETE FROM app_schema_version"),
    (db) => db.exec("DROP TABLE app_schema_version; CREATE TABLE app_schema_version (id INTEGER, fingerprint TEXT)"),
  ]) {
    const db = new Database(":memory:");
    migrate(db);
    change(db);
    const before = snapshot(db);
    assert.throws(() => migrate(db), /SQLITE_SCHEMA_MISMATCH/);
    assert.deepEqual(snapshot(db), before);
    db.close();
  }
  const partial = new Database(":memory:");
  partial.exec("CREATE TABLE customers (id INTEGER); INSERT INTO customers VALUES (77)");
  assert.throws(() => migrate(partial), /SQLITE_SCHEMA_MISMATCH/);
  assert.equal(partial.prepare("SELECT id FROM customers").get().id, 77);
  partial.close();
});

test("explicit reset is forbidden for a file database even with NODE_ENV=test", () => temporary((path) => {
  child(path, `const db=bootstrapDb(); ${fixture} closeDb();`);
  const db = new Database(path);
  const before = snapshot(db);
  db.close();
  child(path, `import assert from 'node:assert/strict'; assert.throws(()=>bootstrapDb({reset:true}),/SQLITE_RESET_FORBIDDEN/); closeDb();`, { env: { NODE_ENV: "test" } });
  const reopened = new Database(path);
  assert.deepEqual(snapshot(reopened), before);
  reopened.close();
}));

test("normal in-memory boot preserves data; explicit test reset recreates fixtures", () => {
  child(":memory:", `import assert from 'node:assert/strict'; const db=bootstrapDb(); db.exec("UPDATE customers SET name='changed'"); bootstrapDb(); assert.equal(db.prepare('SELECT name FROM customers LIMIT 1').get().name,'changed'); bootstrapDb({reset:true}); assert.notEqual(db.prepare('SELECT name FROM customers LIMIT 1').get().name,'changed'); closeDb();`, { env: { NODE_ENV: "test" } });
  child(":memory:", `import assert from 'node:assert/strict'; assert.throws(()=>bootstrapDb({reset:true}),/SQLITE_RESET_FORBIDDEN/); closeDb();`);
});

test("concurrent new-process startup initializes one seed and preserves a usable database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "homeservice-startup-race-"));
  try {
    const path = join(directory, "test.sqlite");
    await Promise.all([child(path, "bootstrapDb(); closeDb();", { asynchronous: true }), child(path, "bootstrapDb(); closeDb();", { asynchronous: true })]);
    const db = new Database(path);
    assert.equal(migrate(db), "preserved");
    assert.equal(db.prepare("SELECT count(*) AS n FROM app_schema_version").get().n, 1);
    assert.ok(db.prepare("SELECT count(*) AS n FROM customers").get().n > 0);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    db.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test("first WAL open waits for a separate initialization lock then preserves data", async () => {
  const directory=mkdtempSync(join(tmpdir(),"homeservice-wal-lock-"));
  const path=join(directory,"test.sqlite"), marker=join(directory,"opening");
  const blocker=new Database(path);
  blocker.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('keep'); BEGIN EXCLUSIVE");
  const attempt=child(path,`import fs from 'node:fs'; import {getDb} from './lib/db/index.js';
    fs.writeFileSync(${JSON.stringify(marker)},'ready');
    const db=getDb(); if(db.prepare('SELECT value FROM retained').get().value!=='keep')throw new Error('data lost'); closeDb();`,{asynchronous:true});
  // Observe failure immediately without an unhandled rejection while parent holds lock.
  let failure; const settled=attempt.catch(error=>{failure=error;});
  try {
    const deadline=Date.now()+5000;
    while(!existsSync(marker)&&!failure&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(existsSync(marker),failure?.message ?? 'child did not start');
    await new Promise(resolve=>setTimeout(resolve,150));
    assert.equal(failure,undefined,'child must wait for the transient initialization lock');
    blocker.exec('COMMIT');
    await settled;if(failure)throw failure;
    assert.equal(blocker.prepare('SELECT value FROM retained').get().value,'keep');
  }finally{if(blocker.inTransaction)blocker.exec('ROLLBACK');await settled;blocker.close();rmSync(directory,{recursive:true,force:true});}
});

test("WAL initialization recovers an immediate SQLITE_BUSY but propagates other errors", () => {
  child(":memory:", `import assert from 'node:assert/strict'; import Database from 'better-sqlite3';
    import {getDb} from './lib/db/index.js';
    const pragma=Database.prototype.pragma; let busy=true;
    Database.prototype.pragma=function(sql,...args){
      if(sql==='journal_mode = WAL'&&busy){busy=false;throw Object.assign(new Error('fixture busy'),{code:'SQLITE_BUSY'});}
      return pragma.call(this,sql,...args);
    };
    const db=getDb(); assert.equal(busy,false); assert.equal(db.pragma('foreign_keys',{simple:true}),1);
    assert.equal(db.pragma('busy_timeout',{simple:true}),3000);closeDb();
    const close=Database.prototype.close;let closed=false;
    Database.prototype.close=function(){closed=true;return close.call(this);};
    Database.prototype.pragma=function(sql,...args){if(sql==='journal_mode = WAL')throw Object.assign(new Error('fixture corrupt'),{code:'SQLITE_CORRUPT'});return pragma.call(this,sql,...args);};
    assert.throws(()=>getDb(),error=>error.code==='SQLITE_CORRUPT');assert.equal(closed,true);
    Database.prototype.pragma=pragma;Database.prototype.close=close;
    getDb();closeDb();`, {env:{NODE_ENV:'test'}});
});
