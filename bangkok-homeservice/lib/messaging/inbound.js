// Area C — receiving side of the shared v1 envelope inside the monolith, plus the idempotent
// receiver (Week 9 slides 26–30). The dedupe row, the consumer's effect and any attention record
// are written in ONE immediate SQLite transaction; a redelivered event finds its row and does nothing.
import { getDb } from "../db/index.js";

export class PermanentEventError extends Error {
  constructor(message) { super(message); this.name = "PermanentEventError"; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEYS = new Set(["event_id", "event_type", "schema_version", "producer", "occurred_at", "aggregate_type", "aggregate_id", "saga_id", "correlation_id", "data"]);
const reject = (message) => { throw new PermanentEventError(`invalid event envelope: ${message}`); };

export function parseEnvelope(content, messageId) {
  let value;
  try { value = JSON.parse(Buffer.isBuffer(content) ? content.toString("utf8") : String(content)); } catch { reject("body is not JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) reject("body");
  for (const key of Object.keys(value)) if (!KEYS.has(key)) reject(`unexpected field ${key}`);
  if (typeof value.event_id !== "string" || !UUID.test(value.event_id)) reject("event_id");
  if (messageId !== undefined && messageId !== null && messageId !== value.event_id) reject("message_id does not match event_id");
  if (typeof value.event_type !== "string" || !/^[a-z]+(\.[a-z_]+)+$/.test(value.event_type)) reject("event_type");
  if (value.schema_version !== 1) reject("schema_version");
  if (!["payments-wallet", "monolith"].includes(value.producer)) reject("producer");
  if (typeof value.occurred_at !== "string" || !Number.isFinite(Date.parse(value.occurred_at))) reject("occurred_at");
  if (typeof value.aggregate_id !== "string" || !value.aggregate_id.length) reject("aggregate_id");
  if (!value.data || typeof value.data !== "object" || Array.isArray(value.data)) reject("data");
  return value;
}

// handlers: { [event_type]: { producer, apply(envelope, ctx) -> outcome string } }
// apply() runs inside the transaction and may call ctx.attention(reason) to flag the event for a
// person instead of applying it. Throw PermanentEventError for malformed data.
export function createInbox({ consumerName, handlers }) {
  return {
    consumerName,
    handle(envelope) {
      const handler = handlers[envelope.event_type];
      if (!handler) throw new PermanentEventError(`${consumerName} does not handle ${envelope.event_type}`);
      if (envelope.producer !== handler.producer) throw new PermanentEventError(`${envelope.event_type} must come from ${handler.producer}`);
      const db = getDb();
      return db.transaction(() => {
        const claimed = db.prepare(
          "INSERT OR IGNORE INTO processed_events (consumer_name, event_id, event_type, producer, outcome) VALUES (?, ?, ?, ?, 'pending')",
        ).run(consumerName, envelope.event_id, envelope.event_type, envelope.producer).changes;
        if (claimed === 0) return { duplicate: true, outcome: null };
        const ctx = {
          attention(reason) {
            db.prepare(
              "INSERT INTO consistency_attention (consumer_name, event_id, event_type, aggregate_id, reason) VALUES (?, ?, ?, ?, ?)",
            ).run(consumerName, envelope.event_id, envelope.event_type, envelope.aggregate_id, reason);
            return "attention";
          },
        };
        const outcome = handler.apply(envelope, ctx);
        db.prepare("UPDATE processed_events SET outcome = ? WHERE consumer_name = ? AND event_id = ?")
          .run(String(outcome), consumerName, envelope.event_id);
        return { duplicate: false, outcome };
      }).immediate();
    },
  };
}

export function positiveId(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > 2147483647) throw new PermanentEventError(`invalid ${name}`);
  return value;
}
