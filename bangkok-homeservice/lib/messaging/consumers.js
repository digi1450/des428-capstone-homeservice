// Area C — the monolith's RabbitMQ consumers. Each consumer owns its queue (publish-subscribe on
// the shared topic exchange), its dedupe name and its dead-letter queue.
//   ack       after the dedupe+effect transaction commits (also for duplicates and attention)
//   reject    permanent problems (bad envelope, wrong producer, malformed data) -> its DLQ
//   requeue   transient failures after a delay; the quorum queue dead-letters after the limit
// Started from instrumentation.js only when AMQP_URL is set.
import amqp from "amqplib";
import { logger } from "../logger.js";
import { createInbox, parseEnvelope, PermanentEventError } from "./inbound.js";
import { EVENTS_EXCHANGE } from "./publisher.js";
import { paymentSucceededHandler } from "../modules/booking/payment-events.js";
import { reviewCreatedHandler } from "../modules/reviews/rating-events.js";

export const DEAD_LETTER_EXCHANGE = "homeservice.dead-letter";
export const CONSUMERS = Object.freeze([
  { name: "booking.payments", queue: "booking.events", handlers: { "payment.succeeded": paymentSucceededHandler } },
  { name: "ratings.reviews", queue: "ratings.events", handlers: { "review.created": reviewCreatedHandler } },
]);

export async function assertTopology(channel, consumer, { deliveryLimit = 5 } = {}) {
  const dlq = `${consumer.queue}.dlq`;
  await channel.assertExchange(EVENTS_EXCHANGE, "topic", { durable: true });
  await channel.assertExchange(DEAD_LETTER_EXCHANGE, "direct", { durable: true });
  await channel.assertQueue(dlq, { durable: true, arguments: { "x-queue-type": "quorum" } });
  await channel.bindQueue(dlq, DEAD_LETTER_EXCHANGE, consumer.queue);
  await channel.assertQueue(consumer.queue, { durable: true, arguments: {
    "x-queue-type": "quorum", "x-delivery-limit": deliveryLimit,
    "x-dead-letter-exchange": DEAD_LETTER_EXCHANGE, "x-dead-letter-routing-key": consumer.queue,
  } });
  for (const key of Object.keys(consumer.handlers)) await channel.bindQueue(consumer.queue, EVENTS_EXCHANGE, key);
}

export async function startConsumer(amqpUrl, consumer, { prefetch = 10, deliveryLimit = 5, retryDelayMs = 1000, log = (e) => logger.info(e, "event consumer") } = {}) {
  const inbox = createInbox({ consumerName: consumer.name, handlers: consumer.handlers });
  const connection = await amqp.connect(amqpUrl);
  const channel = await connection.createChannel();
  await assertTopology(channel, consumer, { deliveryLimit });
  await channel.prefetch(prefetch);
  let closed = false;
  const closedPromise = new Promise((resolve) => {
    const done = () => { closed = true; resolve(); };
    connection.on("close", done);
    channel.on("close", done);
  });
  connection.on("error", () => {});
  channel.on("error", () => {});
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const { consumerTag } = await channel.consume(consumer.queue, async (message) => {
    if (!message) return;
    const messageId = message.properties.messageId ?? null;
    try {
      const envelope = parseEnvelope(message.content, messageId ?? undefined);
      const result = inbox.handle(envelope);
      if (!closed) channel.ack(message);
      log({ event: result.duplicate ? "event_duplicate_skipped" : "event_processed", consumer: consumer.name,
        event_id: envelope.event_id, event_type: envelope.event_type, outcome: result.outcome });
    } catch (error) {
      if (closed) return;
      if (error instanceof PermanentEventError) {
        channel.nack(message, false, false);
        log({ event: "event_dead_lettered", consumer: consumer.name, message_id: messageId, reason: error.message });
      } else {
        log({ event: "event_retry", consumer: consumer.name, message_id: messageId, kind: error?.code ?? error?.name ?? "error" });
        await sleep(retryDelayMs);
        if (!closed) channel.nack(message, false, true);
      }
    }
  });
  return {
    closed: closedPromise,
    async close() {
      try { await channel.cancel(consumerTag); } catch { /* gone */ }
      try { await channel.close(); } catch { /* gone */ }
      try { await connection.close(); } catch { /* gone */ }
    },
  };
}

const LOOP = Symbol.for("edemand.event-consumers");

// Keeps every consumer connected, reconnecting with backoff after broker restarts.
export function startConsumers({ amqpUrl }) {
  if (globalThis[LOOP]) return globalThis[LOOP];
  const state = { stopping: false, running: [] };
  for (const consumer of CONSUMERS) {
    (async () => {
      let delay = 500;
      while (!state.stopping) {
        try {
          const running = await startConsumer(amqpUrl, consumer);
          state.running.push(running);
          logger.info({ consumer: consumer.name }, "event consumer started");
          delay = 500;
          await running.closed;
        } catch (error) {
          logger.error({ consumer: consumer.name, kind: error?.code ?? error?.name ?? "error" }, "event consumer error");
        }
        if (!state.stopping) { await new Promise((r) => { const t = setTimeout(r, delay); t.unref?.(); }); delay = Math.min(delay * 2, 10000); }
      }
    })();
  }
  state.stop = async () => {
    state.stopping = true;
    await Promise.all(state.running.map((r) => r.close()));
    globalThis[LOOP] = undefined;
  };
  globalThis[LOOP] = state;
  return state;
}
