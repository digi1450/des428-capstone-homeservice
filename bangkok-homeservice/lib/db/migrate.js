// Startup creates only an empty database, or adopts the exact current legacy schema.
// Unknown/partial schemas fail closed, never a reset. A KNOWN older schema (current schema minus
// the objects of reviewed UPGRADES, with its exact old fingerprint) is upgraded atomically.
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
const hash = (entries) => createHash("sha256").update(JSON.stringify(entries)).digest("hex");
const fingerprint = hash(expected);

// Additive, reviewed upgrades, oldest first. Each adds whole objects whose CREATE text is taken
// from the current schema (so an upgraded file is byte-identical to a fresh one) plus an optional
// data backfill. Existing objects are never altered or dropped here.
export const UPGRADES = Object.freeze([
  {
    id: "c-booking-saga-activation",
    objects: ["booking_saga_activations", "idx_booking_saga_activations_due"],
    // Sagas completed before activation existed still need Payments eligibility: queue them.
    backfill: `INSERT INTO booking_saga_activations (saga_id, activate_command_id, state)
      SELECT saga_id, 'activate:' || saga_id, 'pending' FROM booking_sagas
      WHERE state = 'COMPLETED' AND intent_json IS NOT NULL`,
  },
  {
    // Step 5C durable financial work. Starts empty: legacy completions/cancellations already did
    // their SQLite money effects and are never replayed as new financial commands.
    id: "c-booking-financial-work",
    objects: ["booking_financial_work", "idx_booking_financial_work_due"],
  },
  {id:"e-event-trace-context",objects:["event_trace_context"]},
  {id:"e-booking-work-trace-context",objects:["booking_work_trace_context"]},
]);
// previous[k] = the schema as it was before UPGRADES[k..] existed.
const previous = UPGRADES.map((_, k) => {
  const added = new Set(UPGRADES.slice(k).flatMap((upgrade) => upgrade.objects));
  const entries = expected.filter((entry) => !added.has(entry.name));
  return { entries, fingerprint: hash(entries) };
});
export const PREVIOUS_FINGERPRINTS = Object.freeze(previous.map((p) => p.fingerprint));
const domain = (entries) => JSON.stringify(entries.filter((entry) => entry.name !== META));

function upgrade(db, actual) {
  const hasMarker = actual.some((entry) => entry.name === META);
  const markerRows = hasMarker ? db.prepare(`SELECT id, fingerprint FROM ${META}`).all() : [];
  for (let k = 0; k < previous.length; k += 1) {
    if (domain(actual) !== domain(previous[k].entries)) continue;
    if (hasMarker && (JSON.stringify(actual) !== JSON.stringify(previous[k].entries)
      || markerRows.length !== 1 || markerRows[0].id !== 1 || markerRows[0].fingerprint !== previous[k].fingerprint)) return null;
    for (const step of UPGRADES.slice(k)) {
      const created = expected.filter((entry) => step.objects.includes(entry.name))
        .sort((a, b) => (a.type === "table" ? 0 : 1) - (b.type === "table" ? 0 : 1));
      for (const entry of created) db.exec(entry.sql);
      if (step.backfill) db.exec(step.backfill);
    }
    if (hasMarker) db.prepare(`UPDATE ${META} SET fingerprint = ? WHERE id = 1`).run(fingerprint);
    else {
      db.exec(META_SQL);
      db.prepare(`INSERT INTO ${META} (id, fingerprint) VALUES (1, ?)`).run(fingerprint);
    }
    if (JSON.stringify(schema(db)) !== JSON.stringify(expected)) throw mismatch(); // rolls back
    return "upgraded";
  }
  return null;
}
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
      const upgraded = upgrade(db, actual);
      if (upgraded) return upgraded;
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
