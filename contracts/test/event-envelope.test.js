import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import { buildEnvelope } from "../../services/payments-wallet/src/messaging/envelope.js";
import { parseEnvelope } from "../../services/notifications/src/messaging/envelope.js";
import { envelopeFromRow } from "../../bangkok-homeservice/lib/messaging/envelope.js";

const schema = JSON.parse(await readFile(new URL("../event-envelope.schema.json", import.meta.url), "utf8"));
const fixtures = JSON.parse(await readFile(new URL("../fixtures/event-envelopes.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ strict: true });
ajv.addFormat("uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
ajv.addFormat("date-time", value => /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)));
const validate = ajv.compile(schema);

test("envelope fixtures match the schema and the consumer parser", () => {
  for (const value of fixtures.valid) {
    assert.ok(validate(value), JSON.stringify(validate.errors));
    assert.equal(parseEnvelope(Buffer.from(JSON.stringify(value)), value.event_id).event_id, value.event_id);
  }
  for (const { reason, value } of fixtures.invalid) {
    assert.equal(validate(value), false, reason);
    assert.throws(() => parseEnvelope(Buffer.from(JSON.stringify(value))), undefined, reason);
  }
});

test("the Payments producer builds envelopes that satisfy the shared schema", () => {
  const envelope = buildEnvelope({ event_type: "payment.succeeded", aggregate_type: "order", aggregate_id: 42,
    data: { order_id: 42, customer_id: 7, provider_id: 3, amount_cents: 100 } }, { correlationId: "req-1" });
  assert.ok(validate(envelope), JSON.stringify(validate.errors));
  assert.equal(envelope.aggregate_id, "42");
  assert.equal(envelope.producer, "payments-wallet");
});

test("the monolith producer builds envelopes from outbox rows that satisfy the shared schema", () => {
  const rows = [
    { type: "booking.status_changed", aggregate_type: "order", aggregate_id: 42,
      payload_json: JSON.stringify({ order_id: 42, from: null, to: "awaiting", customer_id: 7, provider_id: 3, actor_role: "customer" }) },
    { type: "bid.accepted", aggregate_type: "bid", aggregate_id: 9,
      payload_json: JSON.stringify({ job_request_id: 5, order_id: 42, winner_provider_id: 3, loser_provider_ids: [4] }) },
    { type: "provider.approved", aggregate_type: "provider", aggregate_id: 3, payload_json: JSON.stringify({ provider_id: 3 }) },
  ];
  for (const row of rows) {
    const envelope = envelopeFromRow({ ...row, event_uuid: "5d0c7a52-8a77-4f0e-b7c3-6f2d2e1d9a20", created_at: "2026-11-07T07:00:00.000Z" });
    assert.ok(validate(envelope), JSON.stringify(validate.errors));
    assert.equal(envelope.producer, "monolith");
    assert.equal(parseEnvelope(Buffer.from(JSON.stringify(envelope)), envelope.event_id).event_type, row.type);
  }
});
