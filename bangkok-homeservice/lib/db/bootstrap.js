// Normal startup preserves data. Only the isolated in-memory test helper may reset.
import { getDb } from "./index.js";
import { migrate } from "./migrate.js";
import { seed } from "./seed.js";
import { SCHEMA_SQL } from "./schema.js";
import { logger } from "../logger.js";

export function bootstrapDb({ reset = false } = {}) {
  const db = getDb();
  if (reset) {
    if (process.env.NODE_ENV !== "test" || db.name !== ":memory:") {
      throw new Error("SQLITE_RESET_FORBIDDEN: reset is restricted to in-memory tests");
    }
    db.transaction(() => {
      db.exec(SCHEMA_SQL);
      seed(db);
      migrate(db);
    }).immediate();
    logger.info("isolated test database reset");
  } else {
    const action = migrate(db, { initialize: seed });
    logger.info({ action }, "sqlite startup complete");
  }
  return db;
}
