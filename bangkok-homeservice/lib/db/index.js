// Single shared better-sqlite3 connection, cached on globalThis so Next's dev hot-reload (which
// re-evaluates modules) cannot open a second connection to the same file. better-sqlite3 is
// synchronous, so every module that calls getDb() gets the *same* connection object — which is
// exactly what lets a service in one context (e.g. booking) open a db.transaction() that also
// writes through another context's repository (e.g. payments) and have it all commit or roll back
// as one unit.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "../config.js";
import { logger } from "../logger.js";

const CONN = Symbol.for("edemand.db.connection");

// Resolved at open time (not at config eval) so a test can set DB_PATH/NODE_ENV before the first
// getDb() call regardless of ESM import ordering.
function resolveDbPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  if (process.env.NODE_ENV === "test") return ":memory:";
  return path.join(process.cwd(), "data", "edemand.db");
}

export function getDb() {
  if (globalThis[CONN]) return globalThis[CONN];

  const dbPath = resolveDbPath();
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  try {
    // journal_mode may return BUSY immediately during concurrent first opens,
    // even with a busy handler. Retry only this initialization lock, bounded by
    // the same three-second budget used for normal SQLite lock waiting.
    const deadline = Date.now() + 3000;
    db.pragma("busy_timeout = 0");
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
      try { db.pragma("journal_mode = WAL"); break; }
      catch (error) {
        const remaining = deadline - Date.now();
        if (error.code !== "SQLITE_BUSY" || remaining <= 0) throw error;
        Atomics.wait(pause, 0, 0, Math.min(25, remaining));
      }
    }
    db.pragma("busy_timeout = 3000");
    db.pragma("foreign_keys = ON");
  } catch (error) {
    db.close();
    throw error;
  }
  globalThis[CONN] = db;
  logger.info({ dbPath }, "sqlite connection opened");
  return db;
}

export function closeDb() {
  if (globalThis[CONN]) {
    globalThis[CONN].close();
    globalThis[CONN] = undefined;
    logger.info("sqlite connection closed");
  }
}
