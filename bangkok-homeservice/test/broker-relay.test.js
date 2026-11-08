// Area C: the broker relay publishes the monolith's `events` outbox with stable event ids, without
// touching the inherited local relay (processed_at). A fake publisher stands in for RabbitMQ here;
// the real-broker run is tests/integration/c-monolith-to-notifications.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshBoot, getDb } from "../test-helpers/boot.js";
import { call } from "../test-helpers/call.js";
import { loginSeededCustomer, loginSeededProvider, loginAdmin, registerProvider, futureWeekday } from "../test-helpers/auth.js";
import { insertEvent } from "../lib/db/events.js";
import { relayOnce, pendingPublishCount, PUBLISHED_TYPES } from "../lib/messaging/broker-relay.js";
import { envelopeFromRow } from "../lib/messaging/envelope.js";
import { runRelayOnce } from "../lib/modules/notifications/relay.js";
import * as bookings from "../app/api/bookings/route.js";
import * as approve from "../app/api/admin/providers/[id]/approve/route.js";

freshBoot();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const row = (id) => getDb().prepare("SELECT * FROM events WHERE id = ?").get(id);
const capture = () => {
  const sent = [];
  return { sent, publisher: { async publish(envelope) { sent.push(envelope); } } };
};
// Seeded data may already contain events; start each assertion from a clean publish queue.
const drain = async () => relayOnce({ publisher: capture().publisher, owner: "drain", batchSize: 1000 });

test("monolith broker relay", async (t) => {
  const customer = await loginSeededCustomer("nong@example.com");
  const provider = await loginSeededProvider("sparkle@example.com");
  const addressId = getDb().prepare("SELECT id FROM addresses WHERE customer_id = ? LIMIT 1").get(customer.id).id;
  const date = futureWeekday(4);
  const place = (startingTime) => call(bookings.POST, {
    token: customer.token,
    body: { provider_id: provider.id, address_id: addressId, service_date: date, starting_time: startingTime,
      items: [{ service_id: 2, quantity: 1 }], payment_method: "cod" },
  });
  await drain();

  let bookingEvent;
  await t.test("a booking writes its event with a UUID in the same transaction; a rejected booking writes none", async () => {
    const before = getDb().prepare("SELECT count(*) AS n FROM events").get().n;
    const placed = await place("10:00");
    assert.equal(placed.status, 201);
    bookingEvent = getDb().prepare("SELECT * FROM events WHERE type = 'booking.status_changed' AND aggregate_id = ?").get(placed.body.order.id);
    assert.match(bookingEvent.event_uuid, UUID);
    assert.equal(bookingEvent.published_at, null);
    const clash = await place("10:00");
    assert.equal(clash.status, 409);
    assert.equal(getDb().prepare("SELECT count(*) AS n FROM events").get().n, before + 1);
  });

  await t.test("relay publishes the v1 envelope once, keyed by event_uuid, and marks it published", async () => {
    const { sent, publisher } = capture();
    const result = await relayOnce({ publisher, owner: "relay-a" });
    assert.equal(result.published, 1);
    const [envelope] = sent;
    assert.equal(envelope.event_id, bookingEvent.event_uuid);
    assert.equal(envelope.producer, "monolith");
    assert.equal(envelope.event_type, "booking.status_changed");
    assert.equal(envelope.aggregate_id, String(bookingEvent.aggregate_id));
    assert.equal(envelope.data.to, "awaiting");
    assert.notEqual(row(bookingEvent.id).published_at, null);
    const again = capture();
    await relayOnce({ publisher: again.publisher, owner: "relay-a" });
    assert.equal(again.sent.length, 0);
  });

  await t.test("publishing does not consume the event for the inherited local relay, and vice versa", async () => {
    assert.equal(row(bookingEvent.id).processed_at, null);
    assert.ok(runRelayOnce() >= 1);
    assert.notEqual(row(bookingEvent.id).processed_at, null);
    const id = insertEvent("booking.completed", "order", 999001, { order_id: 999001, customer_id: customer.id });
    runRelayOnce();
    assert.notEqual(row(id).processed_at, null);
    const { sent, publisher } = capture();
    await relayOnce({ publisher, owner: "relay-a" });
    assert.deepEqual(sent.map((e) => e.event_id), [row(id).event_uuid], "still published after local dispatch");
  });

  await t.test("payment.succeeded from the legacy SQLite payments module is never published", async () => {
    assert.ok(!PUBLISHED_TYPES.includes("payment.succeeded"));
    const id = insertEvent("payment.succeeded", "order", 999002, { order_id: 999002, provider_id: provider.id, amount_cents: 1 });
    const { sent, publisher } = capture();
    await relayOnce({ publisher, owner: "relay-a" });
    assert.equal(sent.length, 0);
    assert.equal(row(id).published_at, null);
  });

  await t.test("provider approval emits provider.approved atomically with the approval", async () => {
    const admin = await loginAdmin();
    const glowId = getDb().prepare("SELECT id FROM providers WHERE email = 'glow@example.com'").get().id;
    const res = await call(approve.POST, { token: admin.token, params: { id: String(glowId) }, method: "POST" });
    assert.equal(res.status, 200);
    const event = getDb().prepare("SELECT * FROM events WHERE type = 'provider.approved' AND aggregate_id = ?").get(glowId);
    assert.deepEqual(JSON.parse(event.payload_json), { provider_id: glowId });
    const { sent, publisher } = capture();
    await relayOnce({ publisher, owner: "relay-a" });
    assert.deepEqual(sent.map((e) => e.event_type), ["provider.approved"]);
  });

  await t.test("provider registration emits provider.registered in the same transaction (wallet provisioning)", async () => {
    await drain();
    const p = await registerProvider();
    assert.equal(p.reg.status, 201);
    const event = getDb().prepare("SELECT * FROM events WHERE type = 'provider.registered' AND aggregate_id = ?").get(p.id);
    assert.deepEqual(JSON.parse(event.payload_json), { provider_id: p.id }, "no email/name/password in the event");
    const { sent, publisher } = capture();
    await relayOnce({ publisher, owner: "relay-a" });
    assert.deepEqual(sent.map((e) => [e.event_type, e.aggregate_type, e.aggregate_id, e.producer]), [["provider.registered", "provider", String(p.id), "monolith"]]);
    // If the event cannot be written, the provider is not created either (one transaction).
    getDb().exec(`CREATE TRIGGER fail_registered BEFORE INSERT ON events WHEN NEW.type = 'provider.registered'
      BEGIN SELECT RAISE(ABORT, 'simulated outbox failure'); END`);
    try {
      const email = `rollback-${Date.now()}@example.com`;
      const failed = await registerProvider({ email });
      assert.equal(failed.reg.status, 500);
      assert.equal(getDb().prepare("SELECT count(*) AS n FROM providers WHERE email = ?").get(email).n, 0);
    } finally {
      getDb().exec("DROP TRIGGER fail_registered");
    }
  });

  await t.test("a failed publish stays pending with backoff, then is retried", async () => {
    const id = insertEvent("booking.completed", "order", 999003, { order_id: 999003, customer_id: customer.id });
    await relayOnce({ publisher: { async publish() { throw new Error("unroutable: no queue bound for booking.completed"); } }, owner: "relay-a" });
    const failed = row(id);
    assert.equal(failed.published_at, null);
    assert.equal(failed.publish_attempts, 1);
    assert.match(failed.publish_last_error, /unroutable/);
    assert.ok(failed.next_publish_at > new Date().toISOString());
    const early = capture();
    await relayOnce({ publisher: early.publisher, owner: "relay-a" });
    assert.equal(early.sent.length, 0, "not retried before its backoff");
    getDb().prepare("UPDATE events SET next_publish_at = ? WHERE id = ?").run(new Date(0).toISOString(), id);
    const later = capture();
    await relayOnce({ publisher: later.publisher, owner: "relay-a" });
    assert.deepEqual(later.sent.map((e) => e.event_id), [failed.event_uuid]);
  });

  await t.test("crash after publish: a live lease blocks other relays; after expiry the SAME event_uuid is republished", async () => {
    const id = insertEvent("booking.completed", "order", 999004, { order_id: 999004, customer_id: customer.id });
    // State a relay leaves when it dies after the broker confirm but before marking the row.
    getDb().prepare("UPDATE events SET publish_locked_by = 'dead-relay', publish_locked_until = ?, publish_attempts = 1 WHERE id = ?")
      .run(new Date(Date.now() + 400).toISOString(), id);
    const blocked = capture();
    await relayOnce({ publisher: blocked.publisher, owner: "relay-b" });
    assert.equal(blocked.sent.length, 0);
    await new Promise((resolve) => setTimeout(resolve, 450));
    const { sent, publisher } = capture();
    await relayOnce({ publisher, owner: "relay-b" });
    assert.deepEqual(sent.map((e) => e.event_id), [row(id).event_uuid]);
    assert.equal(pendingPublishCount(), 0);
  });

  await t.test("payloads that look like credentials are refused before publishing", () => {
    assert.throws(() => envelopeFromRow({ event_uuid: "x", type: "booking.completed", created_at: new Date().toISOString(),
      aggregate_type: "order", aggregate_id: 1, payload_json: JSON.stringify({ order_id: 1, otp: "1234" }) }), /must not be published/);
  });
});
