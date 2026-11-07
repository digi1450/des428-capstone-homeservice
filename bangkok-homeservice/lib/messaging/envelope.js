// Area C — builds the shared v1 event envelope (contracts/event-envelope.schema.json) from a row of
// the monolith's `events` outbox. Copied deliberately rather than imported from a service: the
// monolith and the extracted services never share runtime code.
export const PRODUCER = "monolith";
const FORBIDDEN_KEY = /pass(word)?|token|secret|otp|authorization|credential/i;

function assertSafe(value, path) {
  if (Array.isArray(value)) { value.forEach((item, i) => assertSafe(item, `${path}[${i}]`)); return; }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) throw new TypeError(`${path}.${key} must not be published`);
      assertSafe(item, `${path}.${key}`);
    }
  }
}

export function envelopeFromRow(row) {
  const data = JSON.parse(row.payload_json);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new TypeError("event payload must be an object");
  assertSafe(data, "data");
  return {
    event_id: row.event_uuid,
    event_type: row.type,
    schema_version: 1,
    producer: PRODUCER,
    occurred_at: new Date(row.created_at).toISOString(),
    aggregate_type: row.aggregate_type,
    aggregate_id: String(row.aggregate_id),
    saga_id: null,
    correlation_id: null,
    data,
  };
}
