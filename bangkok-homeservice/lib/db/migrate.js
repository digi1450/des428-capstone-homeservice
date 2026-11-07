// Startup creates only an empty database, or adopts the exact current legacy schema.
// Unknown/partial/older schemas require an explicit migration, never a reset.
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { SCHEMA_SQL } from "./schema.js";

const META = "app_schema_version";
const META_SQL = `CREATE TABLE app_schema_version (
  id INTEGER PRIMARY KEY CHECK (id = 1), fingerprint TEXT NOT NULL
)`;
const CREATE_SQL = SCHEMA_SQL.replace(/^DROP TABLE IF EXISTS [a-z_]+;\s*$/gm, "");
const schema = (db) => db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
  WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY type, name`).all();
const reference = new Database(":memory:");
let expected;
try {
  reference.exec(CREATE_SQL);
  reference.exec(META_SQL);
  expected = schema(reference);
} finally {
  reference.close();
}
const fingerprint = createHash("sha256").update(JSON.stringify(expected)).digest("hex");
const mismatch = () => new Error("SQLITE_SCHEMA_MISMATCH: existing database was preserved; stop the app, back up the database and apply an explicit compatible migration. Do not reset useful data.");

export function migrate(db, { initialize = () => {} } = {}) {
  return db.transaction(() => {
    const actual = schema(db);
    if (actual.length === 0) {
      db.exec(CREATE_SQL);
      initialize(db);
      db.exec(META_SQL);
      db.prepare(`INSERT INTO ${META} (id, fingerprint) VALUES (1, ?)`).run(fingerprint);
      return "initialized";
    }
    const hasMarker = actual.some((entry) => entry.name === META);
    const expectedDomain = expected.filter((entry) => entry.name !== META);
    if (JSON.stringify(actual.filter((entry) => entry.name !== META)) !== JSON.stringify(expectedDomain)) {
      throw mismatch();
    }
    if (hasMarker) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw mismatch();
      const rows = db.prepare(`SELECT id, fingerprint FROM ${META}`).all();
      if (rows.length !== 1 || rows[0].id !== 1 || rows[0].fingerprint !== fingerprint) throw mismatch();
      return "preserved";
    }
    // Adopt an already populated current-schema database without seeding or replaying work.
    db.exec(META_SQL);
    db.prepare(`INSERT INTO ${META} (id, fingerprint) VALUES (1, ?)`).run(fingerprint);
    return "adopted";
  }).immediate();
}
