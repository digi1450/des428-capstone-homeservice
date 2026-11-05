import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { serviceName } from "./config.js";

export async function migrate(database) {
  const directory = new URL("../migrations/", import.meta.url);
  const names = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  return database.withTransaction(async client => {
    // Serializes migration runners only within this service's database.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [serviceName + ":migrations"]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const applied = [];
    for (const name of names) {
      const sql = await readFile(new URL(name, directory), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const prior = await client.query("SELECT sha256 FROM schema_migrations WHERE version = $1", [name]);
      if (prior.rowCount) {
        if (prior.rows[0].sha256 !== checksum) throw new Error("Applied migration changed: " + name);
        continue;
      }
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version, sha256) VALUES ($1, $2)", [name, checksum]);
      applied.push(name);
    }
    return applied;
  });
}
