import pg from "pg";
import { schemaVersion } from "./config.js";

// Each process receives only its own database URL. C passes this transaction's
// client to business repositories AND outbox/dedupe inserts for atomic effects.
export function createDatabase(databaseUrl) {
  const pool = new pg.Pool({
    connectionString: databaseUrl, max: 5,
    connectionTimeoutMillis: 2000, statement_timeout: 2000, query_timeout: 3000,
  });
  // Do not log connection strings or driver error messages containing credentials.
  pool.on("error", () => console.error(JSON.stringify({ event: "database_idle_client_error" })));
  return {
    query: (text, values) => pool.query(text, values),
    async checkReady() {
      const result = await pool.query("SELECT version FROM schema_migrations WHERE version = $1", [schemaVersion]);
      if (result.rowCount !== 1) throw new Error("Database migration required");
    },
    async withTransaction(work) {
      const client = await pool.connect();
      let discard = false;
      try {
        await client.query("BEGIN");
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { discard = true; }
        throw error;
      } finally {
        client.release(discard);
      }
    },
    close: () => pool.end(),
  };
}
