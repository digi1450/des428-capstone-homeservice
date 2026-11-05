import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../src/database.js";
import { migrate } from "../src/migrations.js";

// Explicit opt-in: use a disposable, isolated database, never a live database.
test("PostgreSQL migrations are repeatable, data is owned locally, and a failed transaction rolls back", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const db = createDatabase(process.env.TEST_DATABASE_URL);
  const table = "probe_" + randomUUID().replaceAll("-", "");
  try {
    await migrate(db);
    assert.deepEqual(await migrate(db), []);
    await db.checkReady();
    const owned = await db.query("SELECT to_regclass('public.notifications') AS owned, to_regclass('public.payment_intents') AS other");
    assert.equal(owned.rows[0].owned, "notifications");
    assert.equal(owned.rows[0].other, null);
    await db.query(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`);
    await assert.rejects(db.withTransaction(async client => {
      await client.query(`INSERT INTO ${table} VALUES (1)`);
      throw new Error("business/outbox failure");
    }), /business\/outbox failure/);
    assert.equal((await db.query(`SELECT * FROM ${table}`)).rowCount, 0);
    await db.withTransaction(async client => { await client.query(`INSERT INTO ${table} VALUES (2)`); });
    assert.equal((await db.query(`SELECT * FROM ${table}`)).rowCount, 1);
  } finally {
    try { await db.query(`DROP TABLE IF EXISTS ${table}`); } finally { await db.close(); }
  }
});
