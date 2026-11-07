// Area C — wallet provisioning consumer (provider.registered -> provisionWallet).
// Week 9 slides 22–30: ack only after the dedupe + effect transaction commits.
//   success / duplicate         -> ack
//   permanent (bad envelope,
//   wrong producer, bad data)   -> reject without requeue -> payments.events.dlq
//   transient (DB down, etc.)   -> wait, requeue; the quorum queue dead-letters after the limit
import amqp from "amqplib";
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

export async function startWalletConsumer({ amqpUrl, inbox, prefetch = 10, deliveryLimit = 5, retryDelayMs = 1000, log = () => {} }) {
  const connection = await amqp.connect(amqpUrl);
  const channel = await connection.createChannel();
  await assertWalletTopology(channel, { deliveryLimit });
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

  const { consumerTag } = await channel.consume(QUEUE, async (message) => {
    if (!message) return;
    const messageId = message.properties.messageId;
    try {
      const envelope = parseEnvelope(message.content, messageId);
      const result = await inbox.handle(envelope);
      if (!closed) channel.ack(message);
      log({ event: result.duplicate ? "event_duplicate_skipped" : "event_processed", event_id: envelope.event_id, event_type: envelope.event_type });
    } catch (error) {
      if (closed) return; // unacked: the broker redelivers
      if (error instanceof PermanentEventError) {
        channel.nack(message, false, false);
        log({ event: "event_dead_lettered", message_id: messageId ?? null, reason: error.message });
      } else {
        log({ event: "event_retry", message_id: messageId ?? null, kind: error?.code ?? error?.name ?? "error" });
        await sleep(retryDelayMs);
        if (!closed) channel.nack(message, false, true);
      }
    }
  });

  return {
    closed: closedPromise,
    async close() {
      try { await channel.cancel(consumerTag); } catch { /* channel already gone */ }
      try { await channel.close(); } catch { /* already closed */ }
      try { await connection.close(); } catch { /* already closed */ }
    },
  };
}
