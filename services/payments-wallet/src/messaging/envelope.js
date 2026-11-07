// Area C — producer side of the shared event envelope (contracts/event-envelope.schema.json).
// Kept inside this service on purpose: services never import each other's runtime.
import { randomUUID } from "node:crypto";

export const PRODUCER = "payments-wallet";
export const SCHEMA_VERSION = 1;
const EVENT_TYPE = /^[a-z]+(\.[a-z_]+)+$/;
const AGGREGATE_TYPE = /^[a-z_]+$/;
// Event payloads cross service boundaries and land in broker storage/logs.
const FORBIDDEN_KEY = /pass(word)?|token|secret|otp|authorization|credential/i;

function fail(message) { throw new TypeError(`invalid outbox event: ${message}`); }
function optionalText(value, name, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.length || value.length > max) fail(name);
  return value;
}
function assertSafeData(value, path = "data") {
  if (Array.isArray(value)) { value.forEach((item, i) => assertSafeData(item, `${path}[${i}]`)); return; }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) fail(`${path}.${key} must not be published`);
      assertSafeData(item, `${path}.${key}`);
    }
  }
}

// event: { event_type, aggregate_type, aggregate_id, data, saga_id?, correlation_id? }
// context: { correlationId?, sagaId? } — optional request/workflow identity from the caller.
export function buildEnvelope(event, context = {}, { now = new Date(), id = randomUUID() } = {}) {
  if (!event || typeof event !== "object") fail("event");
  const { event_type, aggregate_type, data } = event;
  if (typeof event_type !== "string" || event_type.length > 64 || !EVENT_TYPE.test(event_type)) fail("event_type");
  if (typeof aggregate_type !== "string" || aggregate_type.length > 32 || !AGGREGATE_TYPE.test(aggregate_type)) fail("aggregate_type");
  const aggregateId = typeof event.aggregate_id === "number" && Number.isSafeInteger(event.aggregate_id) ? String(event.aggregate_id) : event.aggregate_id;
  if (typeof aggregateId !== "string" || !aggregateId.length || aggregateId.length > 64) fail("aggregate_id");
  if (!data || typeof data !== "object" || Array.isArray(data)) fail("data");
  assertSafeData(data);
  const body = {
    event_id: id,
    event_type,
    schema_version: SCHEMA_VERSION,
    producer: PRODUCER,
    occurred_at: now.toISOString(),
    aggregate_type,
    aggregate_id: aggregateId,
    saga_id: optionalText(event.saga_id ?? context.sagaId, "saga_id", 64),
    correlation_id: optionalText(event.correlation_id ?? context.correlationId, "correlation_id", 128),
    data: JSON.parse(JSON.stringify(data)),
  };
  return body;
}

// Only W3C trace context and the request id travel as AMQP headers (Area E owns the format).
export function traceHeaders(context = {}) {
  const headers = {};
  const pairs = [["traceparent", context.traceparent, 55], ["tracestate", context.tracestate, 512], ["x-request-id", context.requestId, 128]];
  for (const [name, value, max] of pairs) {
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || !value.length || value.length > max || /[\r\n]/.test(value)) fail(`header ${name}`);
    headers[name] = value;
  }
  return headers;
}
