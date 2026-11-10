// Area C — publishes the monolith's `events` outbox to RabbitMQ (Week 8 slides 27–30, Week 9).
// Independent of the inherited in-process relay: that one stamps processed_at and dispatches
// locally; this one tracks published_at. Both read the same rows written in the business
// transaction, so neither can lose a committed event to the other.
//
// Protocol (same as the Payments relay):
//   1. claim due rows with a short lease in one IMMEDIATE SQLite transaction;
//   2. publish OUTSIDE any transaction and wait for the broker confirm;
//   3. mark published (or schedule a retry with backoff).
// A crash between 2 and 3 republishes the same event_uuid after the lease expires: at-least-once.
// Opt-in: started from instrumentation.js only when AMQP_URL is set.
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { getDb } from "../db/index.js";
import { logger } from "../logger.js";
import { envelopeFromRow } from "./envelope.js";
import { createPublisher } from "./publisher.js";

// Event types the monolith owns and publishes. payment.succeeded is NOT here: the legacy SQLite
// payments module still emits it locally, but across the boundary only Payments & Wallet may.
export const PUBLISHED_TYPES = Object.freeze([
  "booking.status_changed", "booking.completed", "bid.accepted", "review.created", "provider.approved",
  "provider.registered", // Area C: Payments & Wallet provisions the provider wallet from this
]);
const MAX_BACKOFF_MS = 60000;
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

function claim(owner, batchSize, leaseMs) {
  const db = getDb();
  const marks = PUBLISHED_TYPES.map(() => "?").join(",");
  const select = db.prepare(
    `SELECT events.*, event_trace_context.headers_json AS trace_headers_json FROM events
      LEFT JOIN event_trace_context ON event_trace_context.event_id=events.id
      WHERE published_at IS NULL AND type IN (${marks}) AND next_publish_at <= ?
        AND (publish_locked_until IS NULL OR publish_locked_until < ?)
      ORDER BY events.id LIMIT ?`,
  );
  const lock = db.prepare(
    "UPDATE events SET publish_locked_by = ?, publish_locked_until = ?, publish_attempts = publish_attempts + 1 WHERE id = ?",
  );
  return db.transaction(() => {
    const now = iso();
    const rows = select.all(...PUBLISHED_TYPES, now, now, batchSize);
    const until = iso(leaseMs);
    for (const row of rows) lock.run(owner, until, row.id);
    return rows.map((row) => ({ ...row, publish_attempts: row.publish_attempts + 1 }));
  }).immediate();
}

function markPublished(owner, id) {
  return getDb().prepare(
    `UPDATE events SET published_at = ?, publish_locked_by = NULL, publish_locked_until = NULL, publish_last_error = NULL
      WHERE id = ? AND publish_locked_by = ? AND published_at IS NULL`,
  ).run(iso(), id, owner).changes;
}

function markFailed(owner, row, error) {
  const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** row.publish_attempts);
  getDb().prepare(
    `UPDATE events SET publish_locked_by = NULL, publish_locked_until = NULL, next_publish_at = ?, publish_last_error = ?
      WHERE id = ? AND publish_locked_by = ? AND published_at IS NULL`,
  ).run(iso(backoff), String(error).slice(0, 200), row.id, owner);
}

// publisher.publish(envelope) must resolve only after a broker confirm of a routable message.
export async function relayOnce({ publisher, owner, batchSize = 50, leaseMs = 30000 }) {
  const rows = claim(owner, batchSize, leaseMs);
  let published = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await publisher.publish(envelopeFromRow(row),row.trace_headers_json?JSON.parse(row.trace_headers_json):{});
      published += markPublished(owner, row.id);
    } catch (error) {
      failed += 1;
      markFailed(owner, row, error?.message ?? "publish failed");
    }
  }
  return { claimed: rows.length, published, failed };
}

const LOOP = Symbol.for("edemand.broker-relay");

export function startBrokerRelay({ amqpUrl, pollMs = 500, batchSize = 50, leaseMs = 30000 } = {}) {
  if (globalThis[LOOP]) return globalThis[LOOP];
  const owner = `monolith-relay:${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const state = { stopping: false, publisher: null };
  const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });
  state.done = (async () => {
    let reconnectDelay = 500;
    logger.info({ owner }, "broker relay started");
    while (!state.stopping) {
      try {
        if (!state.publisher || state.publisher.closed) {
          state.publisher = await createPublisher(amqpUrl);
          reconnectDelay = 500;
        }
        const result = await relayOnce({ publisher: state.publisher, owner, batchSize, leaseMs });
        if (result.claimed) logger.info(result, "broker relay batch");
        if (result.claimed < batchSize) await sleep(pollMs);
      } catch (error) {
        // Never log the broker URL: it carries credentials.
        logger.error({ kind: error?.code ?? error?.name ?? "error" }, "broker relay error");
        if (state.publisher) { await state.publisher.close(); state.publisher = null; }
        await sleep(reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 10000);
      }
    }
  })();
  state.stop = async () => {
    state.stopping = true;
    if (state.publisher) await state.publisher.close();
    globalThis[LOOP] = undefined;
  };
  globalThis[LOOP] = state;
  return state;
}

export function pendingPublishCount() {
  const marks = PUBLISHED_TYPES.map(() => "?").join(",");
  return getDb().prepare(`SELECT count(*) AS n FROM events WHERE published_at IS NULL AND type IN (${marks})`).get(...PUBLISHED_TYPES).n;
}
