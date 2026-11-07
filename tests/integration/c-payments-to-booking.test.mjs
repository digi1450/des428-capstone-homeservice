// Must be the first import: gives the monolith an isolated in-memory SQLite database.
import { freshBoot, getDb } from "../../bangkok-homeservice/test-helpers/boot.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import amqp from "../../services/notifications/node_modules/amqplib/channel_api.js";
import { call } from "../../bangkok-homeservice/test-helpers/call.js";
import { loginSeededCustomer, loginSeededProvider, futureWeekday } from "../../bangkok-homeservice/test-helpers/auth.js";
import * as bookings from "../../bangkok-homeservice/app/api/bookings/route.js";
import { CONSUMERS, startConsumer, assertTopology } from "../../bangkok-homeservice/lib/messaging/consumers.js";
import { createDatabase } from "../../services/payments-wallet/src/database.js";
import { migrate } from "../../services/payments-wallet/src/migrations.js";
import { createPaymentsService } from "../../services/payments-wallet/src/service.js";
import { createOutbox, relayOnce } from "../../services/payments-wallet/src/messaging/outbox.js";
import { createPublisher } from "../../services/payments-wallet/src/messaging/publisher.js";

// Area C: Payments & Wallet PostgreSQL outbox -> RabbitMQ -> monolith Booking sets its OWN
// payment_status. Opt-in, DISPOSABLE database and broker only (purges booking queues).
// Settlement eligibility is stubbed true (saga work); no Keycloak/nginx.
const env = process.env;
const enabled = env.TEST_PAYMENTS_DATABASE_URL && env.TEST_AMQP_URL;

async function eventually(check, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail("timed out waiting for " + label);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("payment.succeeded from Payments & Wallet marks the monolith booking paid once", { skip: !enabled }, async (t) => {
  freshBoot();
  const pay = createDatabase(env.TEST_PAYMENTS_DATABASE_URL);
  const outbox = createOutbox();
  const payments = createPaymentsService(pay, { assertSettlementAllowed: async () => true, stageEvent: outbox.stage });
  const consumerDef = CONSUMERS.find((c) => c.name === "booking.payments");
  const logs = [];
  const orders = [];
  let consumer, publisher, admin, channel;
  const order = (id) => getDb().prepare("SELECT * FROM orders WHERE id = ?").get(id);
  try {
    await migrate(pay);
    await pay.query("UPDATE outbox_events SET published_at = now() WHERE published_at IS NULL");
    admin = await amqp.connect(env.TEST_AMQP_URL);
    channel = await admin.createChannel();
    await assertTopology(channel, consumerDef);
    await channel.purgeQueue(consumerDef.queue);
    await channel.purgeQueue(consumerDef.queue + ".dlq");
    consumer = await startConsumer(env.TEST_AMQP_URL, consumerDef, { retryDelayMs: 100, log: (e) => logs.push(e) });
    publisher = await createPublisher(env.TEST_AMQP_URL);

    const customer = await loginSeededCustomer("nong@example.com");
    const provider = await loginSeededProvider("sparkle@example.com");
    const addressId = getDb().prepare("SELECT id FROM addresses WHERE customer_id = ? LIMIT 1").get(customer.id).id;
    const placed = await call(bookings.POST, { token: customer.token, body: {
      provider_id: provider.id, address_id: addressId, service_date: futureWeekday(5), starting_time: "09:00",
      items: [{ service_id: 2, quantity: 1 }], payment_method: "gateway" } });
    assert.equal(placed.status, 201);
    const booked = order(placed.body.order.id);
    orders.push(booked.id);
    // In-memory order ids restart at 1 on every run: clear leftovers in the disposable Payments DB.
    await pay.query("DELETE FROM outbox_events WHERE aggregate_id = $1", [String(booked.id)]);
    await pay.query("DELETE FROM webhook_events WHERE payload_json->>'gateway_ref' IN (SELECT gateway_ref FROM payment_intents WHERE order_id = $1)", [booked.id]);
    await pay.query("DELETE FROM transactions WHERE order_id = $1", [booked.id]);
    await pay.query("DELETE FROM payment_intents WHERE order_id = $1", [booked.id]);

    let staged;
    await t.test("Payments settles; the event crosses the broker; Booking marks its own order paid", async () => {
      assert.equal(booked.payment_status, "pending");
      const intent = await payments.prepareIntent({ order_id: booked.id, customer_id: booked.customer_id,
        provider_id: booked.provider_id, amount_cents: booked.total_cents, currency: "THB" });
      await payments.settleWebhook({ gateway_event_id: "it-" + randomUUID(), type: "payment_intent.succeeded", gateway_ref: intent.gateway_ref });
      staged = (await pay.query("SELECT * FROM outbox_events WHERE aggregate_id = $1", [String(booked.id)])).rows[0];
      assert.equal(order(booked.id).payment_status, "pending", "nothing changes in Booking until the event arrives");
      await relayOnce({ database: pay, publisher, owner: "it-pay-relay" });
      await eventually(() => order(booked.id).payment_status === "paid", "booking paid");
      const rows = getDb().prepare("SELECT * FROM processed_events WHERE event_id = ?").all(staged.event_id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].outcome, "marked_paid");
    });

    await t.test("redelivery of the same payment event is skipped", async () => {
      await publisher.publish(staged);
      await eventually(() => logs.some((e) => e.event === "event_duplicate_skipped" && e.event_id === staged.event_id), "duplicate skip");
      assert.equal(getDb().prepare("SELECT count(*) AS n FROM processed_events WHERE event_id = ?").get(staged.event_id).n, 1);
      assert.equal(getDb().prepare("SELECT count(*) AS n FROM consistency_attention").get().n, 0);
    });

    await t.test("a payment.succeeded forged by another producer is dead-lettered, booking untouched", async () => {
      const forged = { ...staged.envelope, event_id: randomUUID(), producer: "monolith" };
      channel.publish("homeservice.events", "payment.succeeded", Buffer.from(JSON.stringify(forged)), { messageId: forged.event_id, persistent: true });
      await eventually(async () => (await channel.checkQueue(consumerDef.queue + ".dlq")).messageCount === 1, "booking DLQ");
    });
  } finally {
    if (consumer) await consumer.close();
    if (publisher) await publisher.close();
    if (channel) { try { await channel.purgeQueue(consumerDef.queue + ".dlq"); await channel.purgeQueue("notifications.events"); } catch { /* ignore */ } }
    if (admin) await admin.close();
    try {
      await pay.query("DELETE FROM outbox_events WHERE aggregate_id = ANY($1::text[])", [orders.map(String)]);
      await pay.query("DELETE FROM webhook_events WHERE payload_json->>'gateway_ref' IN (SELECT gateway_ref FROM payment_intents WHERE order_id = ANY($1::integer[]))", [orders]);
      await pay.query("DELETE FROM transactions WHERE order_id = ANY($1::integer[])", [orders]);
      await pay.query("DELETE FROM payment_intents WHERE order_id = ANY($1::integer[])", [orders]);
    } finally { await pay.close(); }
  }
});
