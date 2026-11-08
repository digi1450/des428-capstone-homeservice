// Must be the first import: gives the monolith an isolated in-memory SQLite database.
import { freshBoot } from "../../bangkok-homeservice/test-helpers/boot.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import amqp from "../../services/notifications/node_modules/amqplib/channel_api.js";
import { startConsumers, startConsumer as startMonolithConsumer, assertTopology, ConsumerSetupError as MonolithSetupError } from "../../bangkok-homeservice/lib/messaging/consumers.js";
import { EVENTS_EXCHANGE } from "../../bangkok-homeservice/lib/messaging/publisher.js";
import { startConsumer, superviseConsumer, ConsumerSetupError } from "../../services/notifications/src/messaging/consumer.js";
import { QUEUE as NOTES_QUEUE, DEAD_LETTER_QUEUE as NOTES_DLQ, assertConsumerTopology } from "../../services/notifications/src/messaging/topology.js";

// Area C: the lifecycle faults A found in the wallet consumer (#30 review), applied to the two
// consumers already on main: Notifications (#14) and the monolith's (#16).
//   1. broker-initiated basic.cancel must end the subscription and the supervisor must resubscribe
//   2. an incompatible existing queue must reject startup cleanly (no unhandled 'error', no leak,
//      nothing deleted)
// Opt-in, DISPOSABLE RabbitMQ only: the test deletes and redeclares the queues it touches.
const url = process.env.TEST_AMQP_URL;

async function eventually(check, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
const bounded = (promise, ms) => Promise.race([promise.then(() => "resolved"), new Promise((r) => setTimeout(() => r("still pending"), ms))]);
const envelope = (type, producer, data) => ({ event_id: randomUUID(), event_type: type, schema_version: 1, producer,
  occurred_at: new Date().toISOString(), aggregate_type: "provider", aggregate_id: "1", saga_id: null, correlation_id: null, data });

test("consumer lifecycle faults (Notifications and monolith)", { skip: !url }, async (t) => {
  freshBoot();
  const connection = await amqp.connect(url);
  connection.on("error", () => {});
  t.after(() => connection.close());
  const admin = async (work) => { const ch = await connection.createChannel(); ch.on("error", () => {}); try { return await work(ch); } finally { try { await ch.close(); } catch {} } };
  const publish = (event) => admin(async (ch) => { ch.publish(EVENTS_EXCHANGE, event.event_type, Buffer.from(JSON.stringify(event)), { persistent: true, messageId: event.event_id }); });
  let unhandled = null;
  const onError = (error) => { unhandled = error; };
  process.on("uncaughtException", onError);
  t.after(() => process.off("uncaughtException", onError));

  await t.test("Notifications: broker cancel wakes `closed`; the supervisor resubscribes and handles a new event", async () => {
    const handled = [];
    const inbox = { handle: async (e) => { handled.push(e.event_id); return { duplicate: false, effects: 1 }; } };
    const single = await startConsumer({ amqpUrl: url, inbox });
    await admin((ch) => ch.deleteQueue(NOTES_QUEUE));
    assert.equal(await bounded(single.closed, 2000), "resolved");
    assert.equal(await single.closed, "cancelled_by_broker");
    await single.close();

    const logs = [];
    const supervisor = superviseConsumer({ amqpUrl: url, inbox, minDelayMs: 50, maxDelayMs: 200, log: (e) => logs.push(e) });
    t.after(() => supervisor.stop());
    await eventually(() => logs.some((e) => e.event === "consumer_started"), "first subscription");
    await admin((ch) => ch.deleteQueue(NOTES_QUEUE));
    await eventually(() => logs.filter((e) => e.event === "consumer_started").length === 2, "replacement subscription");
    const event = envelope("provider.approved", "monolith", { provider_id: 1 });
    await publish(event);
    await eventually(() => handled.includes(event.event_id), "event handled by the replacement");
    await supervisor.stop();
  });

  await t.test("Notifications: incompatible DLQ rejects startup cleanly and is kept", async () => {
    await admin(async (ch) => { await ch.deleteQueue(NOTES_QUEUE); await ch.deleteQueue(NOTES_DLQ); await ch.assertQueue(NOTES_DLQ, { durable: true }); });
    try {
      await assert.rejects(startConsumer({ amqpUrl: url, inbox: { handle: async () => ({}) } }), (e) => e instanceof ConsumerSetupError && /PRECONDITION/.test(e.message));
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(unhandled, null);
      assert.equal((await admin((ch) => ch.checkQueue(NOTES_DLQ))).queue, NOTES_DLQ);
    } finally {
      await admin(async (ch) => { await ch.deleteQueue(NOTES_DLQ); await assertConsumerTopology(ch); });
    }
  });

  const probe = { name: "c.lifecycle.probe", queue: "c.lifecycle.probe", handlers: {
    "lifecycle.probe": { producer: "monolith", apply: () => "applied" },
  } };

  await t.test("monolith: broker cancel wakes `closed`; startConsumers resubscribes and handles a new event", async () => {
    const single = await startMonolithConsumer(url, probe, { log: () => {} });
    await admin((ch) => ch.deleteQueue(probe.queue));
    assert.equal(await bounded(single.closed, 2000), "resolved");
    await single.close();

    const logs = [];
    const loop = startConsumers({ amqpUrl: url, consumers: [probe], minDelayMs: 50, maxDelayMs: 200, options: { log: (e) => logs.push(e) } });
    t.after(() => loop.stop());
    const subscribed = async () => { try { return (await admin((ch) => ch.checkQueue(probe.queue))).consumerCount === 1; } catch { return false; } };
    await eventually(subscribed, "first subscription");
    await admin((ch) => ch.deleteQueue(probe.queue));
    await eventually(() => logs.some((e) => e.event === "consumer_cancelled_by_broker"), "cancel seen");
    await eventually(subscribed, "replacement subscription");
    const event = envelope("lifecycle.probe", "monolith", {});
    await publish(event);
    await eventually(() => logs.some((e) => e.event === "event_processed" && e.event_id === event.event_id), "event handled by the replacement");
    await loop.stop();
  });

  await t.test("monolith: incompatible DLQ rejects startup cleanly and is kept", async () => {
    const dlq = `${probe.queue}.dlq`;
    await admin(async (ch) => { await ch.deleteQueue(probe.queue); await ch.deleteQueue(dlq); await ch.assertQueue(dlq, { durable: true }); });
    try {
      await assert.rejects(startMonolithConsumer(url, probe, { log: () => {} }), (e) => e instanceof MonolithSetupError && /PRECONDITION/.test(e.message));
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(unhandled, null);
      assert.equal((await admin((ch) => ch.checkQueue(dlq))).queue, dlq);
    } finally {
      await admin(async (ch) => { await ch.deleteQueue(dlq); await ch.deleteQueue(probe.queue); });
    }
  });
});
