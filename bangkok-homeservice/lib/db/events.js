// The outbox. Every state change writes an events row in the SAME transaction as the change, so a
// crash can never leave "state changed but event lost" (or vice-versa). The notifications relay is
// the sole consumer: it claims each row by stamping processed_at, then dispatches. Shared infra, so
// it lives under lib/db rather than in any one bounded context.
import { randomUUID } from "node:crypto";
import { getDb } from "./index.js";
import {currentCarrier} from '../telemetry/context.js';

// Insert a domain event. MUST be called from inside the caller's transaction so it commits or rolls
// back atomically with the state change that produced it. event_uuid is the stable cross-service
// event_id that the broker relay (lib/messaging) publishes; it never changes on republish.
export function insertEvent(type, aggregateType, aggregateId, payload) {
  const db=getDb();
  return db.transaction(()=>{
  const id=db
    .prepare(
      "INSERT INTO events (type, aggregate_type, aggregate_id, payload_json, event_uuid) VALUES (?, ?, ?, ?, ?)"
    )
    .run(type, aggregateType, aggregateId, JSON.stringify(payload), randomUUID()).lastInsertRowid;
  const headers=currentCarrier();
  if(Object.keys(headers).length)db.prepare('INSERT INTO event_trace_context (event_id,headers_json) VALUES (?,?)').run(id,JSON.stringify(headers));
  return id;
  })();
}

export function listUnprocessed(limit = 100) {
  return getDb()
    .prepare("SELECT * FROM events WHERE processed_at IS NULL ORDER BY id LIMIT ?")
    .all(limit);
}

// Idempotent claim: only the first drainer to reach a row flips processed_at from NULL. A
// concurrent (or re-entrant) relay pass sees changes === 0 and skips — the event is applied once.
export function claim(eventId) {
  return getDb()
    .prepare(
      "UPDATE events SET processed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND processed_at IS NULL"
    )
    .run(eventId).changes;
}
