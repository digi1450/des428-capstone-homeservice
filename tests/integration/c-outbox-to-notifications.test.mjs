import { test } from "node:test";
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import amqp from "../../services/notifications/node_modules/amqplib/channel_api.js";
import { createDatabase as paymentsDatabase } from "../../services/payments-wallet/src/database.js";
import { migrate as migratePayments } from "../../services/payments-wallet/src/migrations.js";
import { createPaymentsService } from "../../services/payments-wallet/src/service.js";
import { createOutbox, relayOnce } from "../../services/payments-wallet/src/messaging/outbox.js";
import { createPublisher } from "../../services/payments-wallet/src/messaging/publisher.js";
import { createDatabase as notificationsDatabase } from "../../services/notifications/src/database.js";
import { migrate as migrateNotifications } from "../../services/notifications/src/migrations.js";
import { createInbox } from "../../services/notifications/src/messaging/inbox.js";
import { startConsumer } from "../../services/notifications/src/messaging/consumer.js";
import { QUEUE, DEAD_LETTER_QUEUE, EVENTS_EXCHANGE, assertConsumerTopology } from "../../services/notifications/src/messaging/topology.js";

// Area C first cross-boundary flow: Payments PostgreSQL outbox -> RabbitMQ -> Notifications
// PostgreSQL inbox. Opt-in only, against DISPOSABLE databases and a DISPOSABLE broker:
// the test purges the Notifications queue and dead-letter queue.
// Not covered here: Keycloak, the Booking saga, settlement eligibility (stubbed true) and nginx.
const env = process.env;
const enabled = env.TEST_PAYMENTS_DATABASE_URL && env.TEST_NOTIFICATIONS_DATABASE_URL && env.TEST_AMQP_URL;

async function eventually(check, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail("timed out waiting for " + label);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

test("payment.succeeded crosses Payments -> RabbitMQ -> Notifications exactly once in effect", { skip: !enabled }, async t => {
  const pay = paymentsDatabase(env.TEST_PAYMENTS_DATABASE_URL);
  const notes = notificationsDatabase(env.TEST_NOTIFICATIONS_DATABASE_URL);
  const outbox = createOutbox();
  const payments = createPaymentsService(pay, { assertSettlementAllowed: async () => true, stageEvent: outbox.stage });
  const base = randomInt(700000000, 800000000);
  const providerId = base + 3;
  const orders = [];
  const logs = [];
  let consumer, publisher, admin, adminChannel;
  const owner = "it-relay-" + randomUUID().slice(0, 8);
  const count = async () => (await notes.query("SELECT count(*)::int AS n FROM notifications WHERE recipient_role='provider' AND recipient_id=$1", [providerId])).rows[0].n;
  const outboxFor = async order => (await pay.query("SELECT * FROM outbox_events WHERE aggregate_id=$1", [String(order)])).rows[0];
  const settle = async () => {
    const order = base + 10 + orders.length;
    orders.push(order);
    const intent = await payments.prepareIntent({ order_id: order, customer_id: base + 2, provider_id: providerId, amount_cents: 1000 + orders.length, currency: "THB" });
    await payments.settleWebhook({ gateway_event_id: "it-" + randomUUID(), type: "payment_intent.succeeded", gateway_ref: intent.gateway_ref });
    return order;
  };
  const start = async () => startConsumer({ amqpUrl: env.TEST_AMQP_URL, inbox: createInbox(notes), retryDelayMs: 100, log: entry => logs.push(entry) });
  try {
    await migratePayments(pay);
    await migrateNotifications(notes);
    // Only this test's rows should be relayed.
    await pay.query("UPDATE outbox_events SET published_at = now() WHERE published_at IS NULL");
    admin = await amqp.connect(env.TEST_AMQP_URL);
    adminChannel = await admin.createChannel();
    await assertConsumerTopology(adminChannel);
    await adminChannel.purgeQueue(QUEUE);
    await adminChannel.purgeQueue(DEAD_LETTER_QUEUE);
    consumer = await start();
    publisher = await createPublisher(env.TEST_AMQP_URL);

    let first;
    await t.test("committed event waits in the outbox while no relay runs, then is delivered", async () => {
      first = await settle();
      const staged = await outboxFor(first);
      assert.equal(staged.published_at, null);
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal(await count(), 0, "nothing is delivered without the relay");
      await relayOnce({ database: pay, publisher, owner });
      await eventually(async () => (await count()) === 1, "notification");
      assert.notEqual((await outboxFor(first)).published_at, null);
      const processed = (await notes.query("SELECT * FROM processed_events WHERE event_id=$1", [staged.event_id])).rows;
      assert.equal(processed.length, 1);
      assert.equal(processed[0].effect_count, 1);
    });

    await t.test("republishing the same event (relay crashed after publish) does not duplicate the effect", async () => {
      const staged = await outboxFor(first);
      await pay.query("UPDATE outbox_events SET published_at = NULL, next_attempt_at = now() WHERE event_id=$1", [staged.event_id]);
      await relayOnce({ database: pay, publisher, owner });
      await publisher.publish(staged); // and once more straight to the broker
      await eventually(() => logs.filter(e => e.event === "event_duplicate_skipped" && e.event_id === staged.event_id).length === 2, "two duplicate skips");
      assert.equal(await count(), 1);
      assert.equal((await notes.query("SELECT count(*)::int AS n FROM processed_events WHERE event_id=$1", [staged.event_id])).rows[0].n, 1);
    });

    await t.test("while the consumer is down the event waits in RabbitMQ and is applied after restart", async () => {
      await consumer.close();
      consumer = null;
      const order = await settle();
      await relayOnce({ database: pay, publisher, owner });
      assert.notEqual((await outboxFor(order)).published_at, null);
      await eventually(async () => (await adminChannel.checkQueue(QUEUE)).messageCount === 1, "message held by broker");
      assert.equal(await count(), 1);
      consumer = await start();
      await eventually(async () => (await count()) === 2, "notification after restart");
    });

    await t.test("an invalid envelope is dead-lettered instead of being acknowledged or retried forever", async () => {
      const bad = { event_id: randomUUID(), event_type: "payment.succeeded", schema_version: 2, producer: "payments-wallet",
        occurred_at: new Date().toISOString(), aggregate_type: "order", aggregate_id: "1", data: {} };
      adminChannel.publish(EVENTS_EXCHANGE, "payment.succeeded", Buffer.from(JSON.stringify(bad)), { messageId: bad.event_id, persistent: true });
      const forged = { ...bad, schema_version: 1, producer: "monolith", data: { order_id: 1, provider_id: providerId, amount_cents: 1 } };
      forged.event_id = randomUUID();
      adminChannel.publish(EVENTS_EXCHANGE, "payment.succeeded", Buffer.from(JSON.stringify(forged)), { messageId: forged.event_id, persistent: true });
      await eventually(async () => (await adminChannel.checkQueue(DEAD_LETTER_QUEUE)).messageCount === 2, "two dead letters");
      assert.equal((await adminChannel.checkQueue(QUEUE)).messageCount, 0);
      assert.equal(await count(), 2);
    });

    await t.test("an unroutable event is not marked published", async () => {
      const id = await pay.withTransaction(client => outbox.stage(client, { event_type: "test.unbound_event", aggregate_type: "order", aggregate_id: base + 99, data: { order_id: base + 99 } }));
      orders.push(base + 99);
      await relayOnce({ database: pay, publisher, owner });
      const row = (await pay.query("SELECT * FROM outbox_events WHERE event_id=$1", [id])).rows[0];
      assert.equal(row.published_at, null);
      assert.match(row.last_error, /unroutable/);
    });
  } finally {
    if (consumer) await consumer.close();
    if (publisher) await publisher.close();
    if (adminChannel) { try { await adminChannel.purgeQueue(DEAD_LETTER_QUEUE); } catch { /* ignore */ } }
    if (admin) await admin.close();
    try {
      const eventIds = (await pay.query("SELECT event_id FROM outbox_events WHERE aggregate_id = ANY($1::text[])", [orders.map(String)])).rows.map(r => r.event_id);
      await notes.query("DELETE FROM processed_events WHERE event_id = ANY($1::uuid[])", [eventIds]);
      await notes.query("DELETE FROM notifications WHERE recipient_role='provider' AND recipient_id=$1", [providerId]);
      await pay.query("DELETE FROM outbox_events WHERE aggregate_id = ANY($1::text[])", [orders.map(String)]);
      await pay.query("DELETE FROM webhook_events WHERE payload_json->>'gateway_ref' IN (SELECT gateway_ref FROM payment_intents WHERE order_id = ANY($1::integer[]))", [orders]);
      await pay.query("DELETE FROM transactions WHERE order_id = ANY($1::integer[])", [orders]);
      await pay.query("DELETE FROM payment_intents WHERE order_id = ANY($1::integer[])", [orders]);
    } finally { await pay.close(); await notes.close(); }
  }
});
