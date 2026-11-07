// Area C — consumer-side validation of the shared envelope for Payments & Wallet
// (contracts/event-envelope.schema.json). Same rules as Notifications; kept inside this service
// on purpose (services never import each other's runtime). Failures here are PERMANENT:
// retrying cannot fix them, so the consumer dead-letters them for a person to inspect.

export class PermanentEventError extends Error {
  constructor(message) { super(message); this.name = "PermanentEventError"; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_TYPE = /^[a-z]+(\.[a-z_]+)+$/;
const KEYS = new Set(["event_id", "event_type", "schema_version", "producer", "occurred_at", "aggregate_type", "aggregate_id", "saga_id", "correlation_id", "data"]);
// Which producer may emit each event this service consumes.
export const EXPECTED_PRODUCER = Object.freeze({ "provider.registered": "monolith" });

function reject(message) { throw new PermanentEventError(`invalid event envelope: ${message}`); }
function optionalText(value, name, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.length || value.length > max) reject(name);
  return value;
}

export function parseEnvelope(content, messageId) {
  let value;
  try { value = JSON.parse(Buffer.isBuffer(content) ? content.toString("utf8") : String(content)); } catch { reject("body is not JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) reject("body");
  for (const key of Object.keys(value)) if (!KEYS.has(key)) reject(`unexpected field ${key}`);
  if (typeof value.event_id !== "string" || !UUID.test(value.event_id)) reject("event_id");
  if (messageId !== undefined && messageId !== null && messageId !== value.event_id) reject("message_id does not match event_id");
  if (typeof value.event_type !== "string" || value.event_type.length > 64 || !EVENT_TYPE.test(value.event_type)) reject("event_type");
  if (value.schema_version !== 1) reject("schema_version");
  if (!["payments-wallet", "monolith"].includes(value.producer)) reject("producer");
  if (typeof value.occurred_at !== "string" || !Number.isFinite(Date.parse(value.occurred_at))) reject("occurred_at");
  if (typeof value.aggregate_type !== "string" || !/^[a-z_]+$/.test(value.aggregate_type) || value.aggregate_type.length > 32) reject("aggregate_type");
  if (typeof value.aggregate_id !== "string" || !value.aggregate_id.length || value.aggregate_id.length > 64) reject("aggregate_id");
  optionalText(value.saga_id, "saga_id", 64);
  optionalText(value.correlation_id, "correlation_id", 128);
  if (!value.data || typeof value.data !== "object" || Array.isArray(value.data)) reject("data");
  return value;
}
