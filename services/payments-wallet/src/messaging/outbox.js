// Area C — transactional outbox (Week 8, slides 27–30).
//   stage():    INSERT the event with the caller's transaction client, so the business
//               change and its event commit together or not at all.
//   relayOnce(): claim due rows with a short lease (own short transaction), publish
//               outside any DB transaction, then mark published. A crash between
//               publish and mark leaves the lease to expire and the SAME event_id is
//               published again: at-least-once, never lost once committed.
import { buildEnvelope, traceHeaders } from "./envelope.js";

const MAX_BACKOFF_SECONDS = 60;

export function createOutbox() {
  return {
    // Signature matches the Payments `stageEvent(client, event)` hook; context is optional.
    async stage(client, event, context = {}) {
      if (!client || typeof client.query !== "function") {
        throw new TypeError("outbox.stage requires the business transaction client");
      }
      const envelope = buildEnvelope(event, context);
      const headers = traceHeaders(context);
      await client.query(
        `INSERT INTO outbox_events (event_id, event_type, aggregate_type, aggregate_id, envelope, headers)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [envelope.event_id, envelope.event_type, envelope.aggregate_type, envelope.aggregate_id, envelope, headers],
      );
      return envelope.event_id;
    },
  };
}

async function claim(database, { owner, batchSize, leaseMs }) {
  const result = await database.query(
    `UPDATE outbox_events
        SET locked_by = $1, locked_until = now() + make_interval(secs => $2::double precision / 1000), attempts = attempts + 1
      WHERE event_id IN (
        SELECT event_id FROM outbox_events
         WHERE published_at IS NULL AND next_attempt_at <= now()
           AND (locked_until IS NULL OR locked_until < now())
         ORDER BY seq
         LIMIT $3
         FOR UPDATE SKIP LOCKED)
      RETURNING seq, event_id, event_type, envelope, headers, attempts`,
    [owner, leaseMs, batchSize],
  );
  return result.rows.sort((a, b) => Number(a.seq) - Number(b.seq));
}

async function markPublished(database, owner, ids) {
  if (!ids.length) return 0;
  const result = await database.query(
    `UPDATE outbox_events SET published_at = now(), locked_by = NULL, locked_until = NULL, last_error = NULL
      WHERE event_id = ANY($1::uuid[]) AND locked_by = $2 AND published_at IS NULL`,
    [ids, owner],
  );
  return result.rowCount;
}

async function markFailed(database, owner, failures) {
  for (const { id, error } of failures) {
    await database.query(
      `UPDATE outbox_events
          SET locked_by = NULL, locked_until = NULL, last_error = $3,
              next_attempt_at = now() + make_interval(secs => least($4::double precision, power(2, attempts)))
        WHERE event_id = $1 AND locked_by = $2 AND published_at IS NULL`,
      [id, owner, String(error).slice(0, 200), MAX_BACKOFF_SECONDS],
    );
  }
}

// publisher.publish(row) resolves only after a broker confirm for a routable message.
export async function relayOnce({ database, publisher, owner, batchSize = 50, leaseMs = 30000 }) {
  const rows = await claim(database, { owner, batchSize, leaseMs });
  const published = [];
  const failures = [];
  for (const row of rows) {
    try {
      await publisher.publish(row);
      published.push(row.event_id);
    } catch (error) {
      failures.push({ id: row.event_id, error: error?.message ?? "publish failed" });
    }
  }
  const marked = await markPublished(database, owner, published);
  await markFailed(database, owner, failures);
  return { claimed: rows.length, published: marked, failed: failures.length };
}

export async function pendingCount(database) {
  const result = await database.query("SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL");
  return result.rows[0].n;
}
