// Area C — the monolith's RabbitMQ consumers. Each consumer owns its queue (publish-subscribe on
// the shared topic exchange), its dedupe name and its dead-letter queue.
//   ack       after the dedupe+effect transaction commits (also for duplicates and attention)
//   reject    permanent problems (bad envelope, wrong producer, malformed data) -> its DLQ
//   requeue   transient failures after a delay; the quorum queue dead-letters after the limit
// Started from instrumentation.js only when AMQP_URL is set.
import amqp from "amqplib";
import {SpanKind} from '@opentelemetry/api';
import {traced,traceFields} from '../telemetry/context.js';
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

export class ConsumerSetupError extends Error {
  constructor(message, cause) { super(message, { cause }); this.name = "ConsumerSetupError"; this.code = cause?.code; }
}

// Lifecycle (same fix as the Payments wallet consumer, A's review on #30): `closed` resolves on any
// end of the subscription, including broker-initiated basic.cancel; error handlers are attached
// before topology RPCs; a failed setup closes partial resources and rejects (never auto-deletes).
export async function startConsumer(amqpUrl, consumer, { prefetch = 10, deliveryLimit = 5, retryDelayMs = 1000, log = (e) => logger.info(e, "event consumer") } = {}) {
  const inbox = createInbox({ consumerName: consumer.name, handlers: consumer.handlers });
  let connection = null;
  let channel = null;
  let ended = false;
  let wake;
  const closedPromise = new Promise((resolve) => { wake = resolve; });
  const end = (reason) => { if (!ended) { ended = true; wake(reason); } };
  const release = async () => {
    try { if (channel) await channel.close(); } catch { /* gone */ }
    try { if (connection) await connection.close(); } catch { /* gone */ }
  };
  let consumerTag;
  try {
    connection = await amqp.connect(amqpUrl);
    connection.on("error", (error) => log({ event: "broker_connection_error", consumer: consumer.name, kind: error?.code ?? error?.name ?? "error" }));
    connection.on("close", () => end("connection_closed"));
    channel = await connection.createChannel();
    channel.on("error", (error) => log({ event: "broker_channel_error", consumer: consumer.name, kind: error?.code ?? error?.name ?? "error" }));
    channel.on("close", () => end("channel_closed"));
    try {
      await assertTopology(channel, consumer, { deliveryLimit });
    } catch (error) {
      throw new ConsumerSetupError(`incompatible or unavailable RabbitMQ topology for ${consumer.queue}: ${error?.message ?? error}`, error);
    }
    await channel.prefetch(prefetch);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    ({ consumerTag } = await channel.consume(consumer.queue, async (message) => {
      if (!message) { log({ event: "consumer_cancelled_by_broker", consumer: consumer.name }); end("cancelled_by_broker"); return; }
      const messageId = message.properties.messageId ?? null;
      try {
        await traced('rabbitmq process',{carrier:message.properties.headers,kind:SpanKind.CONSUMER,attributes:{'messaging.system':'rabbitmq','messaging.operation.name':'process','messaging.destination.name':consumer.queue,'messaging.message.id':messageId??''}},async()=>{
        const envelope = parseEnvelope(message.content, messageId ?? undefined);
        const result = inbox.handle(envelope);
        if (!ended) channel.ack(message);
        log({ event: result.duplicate ? "event_duplicate_skipped" : "event_processed", consumer: consumer.name,
          event_id: envelope.event_id, event_type: envelope.event_type, outcome: result.outcome,...traceFields() });
        });
      } catch (error) {
        if (ended) return;
        if (error instanceof PermanentEventError) {
          channel.nack(message, false, false);
          log({ event: "event_dead_lettered", consumer: consumer.name, message_id: messageId, reason: error.message });
        } else {
          log({ event: "event_retry", consumer: consumer.name, message_id: messageId, kind: error?.code ?? error?.name ?? "error" });
          await sleep(retryDelayMs);
          if (!ended) channel.nack(message, false, true);
        }
      }
    }));
  } catch (error) {
    ended = true;
    await release();
    throw error;
  }
  return {
    closed: closedPromise,
    async close() {
      end("closed_by_caller");
      try { await channel.cancel(consumerTag); } catch { /* gone */ }
      await release();
    },
  };
}

const LOOP = Symbol.for("edemand.event-consumers");

// Keeps every consumer connected, reconnecting with backoff after broker restarts.
export function startConsumers({ amqpUrl, consumers = CONSUMERS, minDelayMs = 500, maxDelayMs = 10000, options = {} }) {
  if (globalThis[LOOP]) return globalThis[LOOP];
  const state = { stopping: false, running: new Set(), loops: [], wakers: new Set() };
  for (const consumer of consumers) {
    state.loops.push((async () => {
      let delay = minDelayMs;
      while (!state.stopping) {
        let running = null;
        try {
          running = await startConsumer(amqpUrl, consumer, options);
          state.running.add(running);
          if (state.stopping) break;
          logger.info({ consumer: consumer.name }, "event consumer started");
          delay = minDelayMs;
          const reason = await running.closed;
          if (!state.stopping) logger.warn({ consumer: consumer.name, reason }, "event consumer ended; reconnecting");
        } catch (error) {
          logger.error({ consumer: consumer.name, kind: error?.code ?? error?.name ?? "error", setup: error?.name === "ConsumerSetupError" ? error.message : undefined }, "event consumer error");
        } finally {
          if (running) { await running.close(); state.running.delete(running); } // e.g. after a broker cancel
        }
        if (!state.stopping) {
          await new Promise((resolve) => {
            const wake = () => { clearTimeout(timer); state.wakers.delete(wake); resolve(); };
            const timer = setTimeout(wake, delay);
            timer.unref?.();
            state.wakers.add(wake);
          });
          delay = Math.min(delay * 2, maxDelayMs);
        }
      }
    })());
  }
  state.stop = async () => {
    state.stopping = true;
    for (const wake of [...state.wakers]) wake();
    await Promise.all([...state.running].map((r) => r.close()));
    await Promise.all(state.loops);
    globalThis[LOOP] = undefined;
  };
  globalThis[LOOP] = state;
  return state;
}
