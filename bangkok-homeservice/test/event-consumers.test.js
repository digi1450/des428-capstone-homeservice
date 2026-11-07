// Area C: the monolith's broker consumers (Booking paid flag from payment.succeeded, ratings from
// review.created) — dedupe, validation against the booking, attention records and atomicity.
// Broker delivery itself is covered by tests/integration/c-payments-to-booking.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { freshBoot, getDb } from "../test-helpers/boot.js";
import { call } from "../test-helpers/call.js";
import { loginSeededCustomer, loginSeededProvider, futureWeekday } from "../test-helpers/auth.js";
import { CONSUMERS } from "../lib/messaging/consumers.js";
import { createInbox, parseEnvelope, PermanentEventError } from "../lib/messaging/inbound.js";
import * as bookings from "../app/api/bookings/route.js";
import * as cancel from "../app/api/bookings/[id]/cancel/route.js";

freshBoot();
const booking = CONSUMERS.find((c) => c.name === "booking.payments");
const ratings = CONSUMERS.find((c) => c.name === "ratings.reviews");
const inbox = createInbox({ consumerName: booking.name, handlers: booking.handlers });
const order = (id) => getDb().prepare("SELECT * FROM orders WHERE id = ?").get(id);
const attention = (eventId) => getDb().prepare("SELECT * FROM consistency_attention WHERE event_id = ?").all(eventId);
const processed = (eventId) => getDb().prepare("SELECT * FROM processed_events WHERE event_id = ?").all(eventId);
const paid = (o, overrides = {}) => ({
  event_id: randomUUID(), event_type: "payment.succeeded", schema_version: 1, producer: "payments-wallet",
  occurred_at: new Date().toISOString(), aggregate_type: "order", aggregate_id: String(o.id), saga_id: null, correlation_id: null,
  data: { order_id: o.id, customer_id: o.customer_id, provider_id: o.provider_id, amount_cents: o.total_cents }, ...overrides,
});

test("monolith event consumers", async (t) => {
  const customer = await loginSeededCustomer("nong@example.com");
  const provider = await loginSeededProvider("sparkle@example.com");
  const addressId = getDb().prepare("SELECT id FROM addresses WHERE customer_id = ? LIMIT 1").get(customer.id).id;
  const date = futureWeekday(6);
  const place = async (startingTime) => {
    const res = await call(bookings.POST, { token: customer.token, body: {
      provider_id: provider.id, address_id: addressId, service_date: date, starting_time: startingTime,
      items: [{ service_id: 2, quantity: 1 }], payment_method: "gateway" } });
    assert.equal(res.status, 201);
    return order(res.body.order.id);
  };

  await t.test("payment.succeeded marks the booking paid exactly once", async () => {
    const o = await place("09:00");
    assert.equal(o.payment_status, "pending");
    const event = paid(o);
    assert.deepEqual(inbox.handle(event), { duplicate: false, outcome: "marked_paid" });
    assert.equal(order(o.id).payment_status, "paid");
    assert.deepEqual(inbox.handle(event), { duplicate: true, outcome: null });
    assert.equal(processed(event.event_id).length, 1);
    assert.equal(processed(event.event_id)[0].outcome, "marked_paid");
    assert.equal(inbox.handle(paid(o)).outcome, "already_paid", "a different payment event for a paid booking changes nothing");
  });

  await t.test("a payment that does not match the booking is flagged, not applied", async () => {
    const o = await place("11:00");
    const event = paid(o, { data: { order_id: o.id, customer_id: o.customer_id, provider_id: o.provider_id, amount_cents: o.total_cents + 1 } });
    assert.equal(inbox.handle(event).outcome, "attention");
    assert.equal(order(o.id).payment_status, "pending");
    assert.match(attention(event.event_id)[0].reason, /does not match/);
    const unknown = paid({ ...o, id: 999999 });
    assert.equal(inbox.handle(unknown).outcome, "attention");
  });

  await t.test("a late payment never revives a cancelled booking; it is flagged for refund", async () => {
    const o = await place("13:00");
    const res = await call(cancel.POST, { token: customer.token, params: { id: String(o.id) }, method: "POST" });
    assert.equal(res.status, 200);
    const event = paid(order(o.id));
    assert.equal(inbox.handle(event).outcome, "attention");
    assert.equal(order(o.id).status, "cancelled");
    assert.equal(order(o.id).payment_status, "pending");
    assert.match(attention(event.event_id)[0].reason, /refund required/);
  });

  await t.test("wrong producer or malformed data is permanent and leaves no dedupe row", async () => {
    const o = await place("15:00");
    const forged = paid(o, { producer: "monolith" });
    assert.throws(() => inbox.handle(forged), PermanentEventError);
    const malformed = paid(o, { data: { order_id: "x" } });
    assert.throws(() => inbox.handle(malformed), PermanentEventError);
    assert.equal(processed(forged.event_id).length + processed(malformed.event_id).length, 0);
    assert.equal(order(o.id).payment_status, "pending");
    assert.throws(() => parseEnvelope(Buffer.from(JSON.stringify({ ...paid(o), schema_version: 2 }))), PermanentEventError);
  });

  await t.test("dedupe is per consumer: another consumer still sees the same event", async () => {
    const o = await place("13:00"); // the cancelled booking above released these slots
    const event = paid(o);
    inbox.handle(event);
    const other = createInbox({ consumerName: "test.other", handlers: { "payment.succeeded": { producer: "payments-wallet", apply: () => "seen" } } });
    assert.equal(other.handle(event).outcome, "seen");
    assert.equal(processed(event.event_id).length, 2);
  });

  await t.test("review.created recomputes service and provider ratings from the reviews table", async () => {
    const reviewsInbox = createInbox({ consumerName: ratings.name, handlers: ratings.handlers });
    getDb().prepare("UPDATE services SET rating_avg = 0, rating_count = 0 WHERE id = 2").run();
    getDb().prepare("UPDATE provider_profiles SET rating_avg = 0, rating_count = 0 WHERE provider_id = ?").run(provider.id);
    const expected = getDb().prepare("SELECT COUNT(*) AS n FROM reviews WHERE service_id = 2").get().n;
    const event = { ...paid({ id: 1, customer_id: 1, provider_id: 1, total_cents: 1 }), event_type: "review.created", producer: "monolith",
      aggregate_type: "review", data: { review_id: 1, order_id: 1, service_id: 2, provider_id: provider.id, customer_id: customer.id, rating: 5 } };
    assert.equal(reviewsInbox.handle(event).outcome, "recomputed");
    assert.equal(getDb().prepare("SELECT rating_count FROM services WHERE id = 2").get().rating_count, expected);
    assert.equal(reviewsInbox.handle(event).duplicate, true);
    assert.throws(() => reviewsInbox.handle({ ...event, event_id: randomUUID(), producer: "payments-wallet" }), PermanentEventError);
  });
});
