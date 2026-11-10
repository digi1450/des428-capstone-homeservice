// Area C — wallet provisioning consumer (provider.registered -> provisionWallet).
// Week 9 slides 22–30: ack only after the dedupe + effect transaction commits.
//   success / duplicate         -> ack
//   permanent (bad envelope,
//   wrong producer, bad data)   -> reject without requeue -> payments.events.dlq
//   transient (DB down, etc.)   -> wait, requeue; the quorum queue dead-letters after the limit
import amqp from "amqplib";
import {traceWalletProcessing} from '../messaging-tracing.js';
import {context,trace} from '@opentelemetry/api';
import { EXPECTED_PRODUCER, PermanentEventError, parseEnvelope } from "./inbound.js";

export const EVENTS_EXCHANGE = "homeservice.events";
export const DEAD_LETTER_EXCHANGE = "homeservice.dead-letter";
export const QUEUE = "payments.events";
export const DEAD_LETTER_QUEUE = "payments.events.dlq";
export const BINDINGS = Object.freeze(Object.keys(EXPECTED_PRODUCER));
export const CONSUMER_NAME = "payments.wallets";

export async function assertWalletTopology(channel, { deliveryLimit = 5 } = {}) {
  await channel.assertExchange(EVENTS_EXCHANGE, "topic", { durable: true });
  await channel.assertExchange(DEAD_LETTER_EXCHANGE, "direct", { durable: true });
  await channel.assertQueue(DEAD_LETTER_QUEUE, { durable: true, arguments: { "x-queue-type": "quorum" } });
  await channel.bindQueue(DEAD_LETTER_QUEUE, DEAD_LETTER_EXCHANGE, QUEUE);
  await channel.assertQueue(QUEUE, { durable: true, arguments: {
    "x-queue-type": "quorum",
    "x-delivery-limit": deliveryLimit,
    "x-dead-letter-exchange": DEAD_LETTER_EXCHANGE,
    "x-dead-letter-routing-key": QUEUE,
  } });
  for (const key of BINDINGS) await channel.bindQueue(QUEUE, EVENTS_EXCHANGE, key);
}

const PROVIDER_ID = (value) => Number.isInteger(value) && value > 0 && value <= 2147483647;

// business = A's createPaymentsService(...) (provisionWallet is idempotent ON CONFLICT DO NOTHING;
// the dedupe row makes the whole event effect exactly-once per consumer).
export function createWalletInbox(database, business, { consumerName = CONSUMER_NAME } = {}) {
  if (typeof business?.provisionWallet !== "function") throw new TypeError("wallet inbox requires provisionWallet");
  return {
    async handle(envelope) {
      const expected = EXPECTED_PRODUCER[envelope.event_type];
      if (!expected) throw new PermanentEventError(`unsupported event type ${envelope.event_type}`);
      if (envelope.producer !== expected) throw new PermanentEventError(`${envelope.event_type} must come from ${expected}`);
      const providerId = envelope.data.provider_id;
      if (!PROVIDER_ID(providerId) || envelope.aggregate_type !== "provider" || envelope.aggregate_id !== String(providerId)) {
        throw new PermanentEventError("provider.registered data does not identify one provider");
      }
      return database.withTransaction(async (client) => {
        const claimed = await client.query(
          `INSERT INTO processed_events (consumer_name, event_id, event_type, producer)
           VALUES ($1, $2, $3, $4) ON CONFLICT (consumer_name, event_id) DO NOTHING`,
          [consumerName, envelope.event_id, envelope.event_type, envelope.producer],
        );
        if (claimed.rowCount === 0) return { duplicate: true, effects: 0 };
        await business.provisionWallet(providerId, { client });
        return { duplicate: false, effects: 1 };
      });
    },
  };
}

export class ConsumerSetupError extends Error {
  constructor(message, cause) { super(message, { cause }); this.name = "ConsumerSetupError"; this.code = cause?.code; }
}

// Lifecycle: `closed` resolves on ANY end of this subscription (connection/channel close or a
// broker-initiated basic.cancel, e.g. the queue was deleted). The caller's reconnect loop then
// calls close() and starts a fresh consumer that re-asserts topology. Error handlers are attached
// as soon as each resource exists, so a failing topology RPC rejects this promise (and the
// partial resources are closed) instead of crashing the process with an unhandled 'error'.
export async function startWalletConsumer({ amqpUrl, inbox, prefetch = 10, deliveryLimit = 5, retryDelayMs = 1000, log = () => {} }) {
  let connection = null;
  let channel = null;
  let ended = false;
  let wake;
  const closedPromise = new Promise((resolve) => { wake = resolve; });
  const end = (reason) => { if (!ended) { ended = true; wake(reason); } };
  const release = async () => {
    try { if (channel) await channel.close(); } catch { /* already closed */ }
    try { if (connection) await connection.close(); } catch { /* already closed */ }
  };
  let consumerTag;
  try {
    connection = await amqp.connect(amqpUrl);
    connection.on("error", (error) => log({ event: "broker_connection_error", kind: error?.code ?? error?.name ?? "error" }));
    connection.on("close", () => end("connection_closed"));
    channel = await connection.createChannel();
    channel.on("error", (error) => log({ event: "broker_channel_error", kind: error?.code ?? error?.name ?? "error" }));
    channel.on("close", () => end("channel_closed"));
    try {
      await assertWalletTopology(channel, { deliveryLimit });
    } catch (error) {
      // e.g. 406 PRECONDITION_FAILED: an existing queue/exchange has incompatible arguments.
      // Never delete/recreate a useful queue automatically; report it for a person to fix.
      throw new ConsumerSetupError(`incompatible or unavailable RabbitMQ topology for ${QUEUE}/${DEAD_LETTER_QUEUE}: ${error?.message ?? error}`, error);
    }
    await channel.prefetch(prefetch);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    ({ consumerTag } = await channel.consume(QUEUE, async (message) => {
      if (!message) { // broker cancelled this consumer (queue deleted, node failover, ...)
        log({ event: "consumer_cancelled_by_broker" });
        end("cancelled_by_broker");
        return;
      }
      const messageId = message.properties.messageId;
      try {
        await traceWalletProcessing(message,async()=>{
        const envelope = parseEnvelope(message.content, messageId);
        const result = await inbox.handle(envelope);
        if (!ended) channel.ack(message);
        log({ event: result.duplicate ? "event_duplicate_skipped" : "event_processed", event_id: envelope.event_id, event_type: envelope.event_type,traceId:trace.getSpan(context.active())?.spanContext().traceId??null });
        });
      } catch (error) {
        if (ended) return; // unacked: the broker redelivers
        if (error instanceof PermanentEventError) {
          channel.nack(message, false, false);
          log({ event: "event_dead_lettered", message_id: messageId ?? null, reason: error.message });
        } else {
          log({ event: "event_retry", message_id: messageId ?? null, kind: error?.code ?? error?.name ?? "error" });
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
    get ready() { return !ended; },
    closed: closedPromise,
    async close() {
      end("closed_by_caller");
      try { await channel.cancel(consumerTag); } catch { /* channel already gone or consumer cancelled */ }
      await release();
    },
  };
}

// Supervisor used by the process entrypoint: keeps exactly one live subscription, reconnecting
// with bounded backoff after any end (broker restart, cancel, setup failure). stop() ends it.
export function superviseWalletConsumer({ amqpUrl, inbox, log = () => {}, minDelayMs = 500, maxDelayMs = 10000, ...options }) {
  let stopping = false;
  let current = null;
  let wakeSleep = () => {};
  const sleep = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); wakeSleep = () => { clearTimeout(timer); resolve(); }; });
  const done = (async () => {
    let delay = minDelayMs;
    while (!stopping) {
      try {
        current = await startWalletConsumer({ amqpUrl, inbox, log, ...options });
        if (stopping) { await current.close(); current = null; break; } // stop() raced the start
        log({ event: "consumer_started" });
        delay = minDelayMs;
        const reason = await current.closed;
        await current.close(); // e.g. after a broker cancel the connection/channel are still open
        current = null;
        if (!stopping) log({ event: "consumer_ended", reason });
      } catch (error) {
        current = null;
        log({ event: "consumer_error", kind: error?.code ?? error?.name ?? "error", setup: error?.name === "ConsumerSetupError" ? error.message : undefined });
      }
      if (!stopping) { await sleep(delay); delay = Math.min(delay * 2, maxDelayMs); }
    }
  })();
  return {
    get ready() { return !stopping && current?.ready === true; },
    done,
    async stop() {
      stopping = true;
      wakeSleep();
      if (current) await current.close();
      await done;
    },
  };
}
