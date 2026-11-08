// Area C — RabbitMQ consumer loop for Notifications (Week 9 slides 22–29).
// Acknowledge ONLY after the dedupe+effect transaction has committed:
//   success / duplicate        -> ack
//   permanent (bad envelope,
//   unsupported, invalid data) -> reject without requeue -> dead-letter queue
//   transient (DB down, etc.)  -> wait, then requeue; the quorum queue dead-letters
//                                 it after x-delivery-limit redeliveries
import amqp from "amqplib";
import { parseEnvelope, PermanentEventError } from "./envelope.js";
import { QUEUE, assertConsumerTopology } from "./topology.js";

export class ConsumerSetupError extends Error {
  constructor(message, cause) { super(message, { cause }); this.name = "ConsumerSetupError"; this.code = cause?.code; }
}

// Lifecycle (same fix as the Payments wallet consumer, A's review on #30):
// `closed` resolves on ANY end of this subscription, including a broker-initiated basic.cancel
// (e.g. the queue was deleted). Error handlers are attached as soon as each resource exists, so a
// failing topology RPC rejects (with partial resources closed) instead of an unhandled 'error'.
export async function startConsumer({ amqpUrl, inbox, prefetch = 10, deliveryLimit = 5, retryDelayMs = 1000, log = () => {} }) {
  let connection = null;
  let channel = null;
  let ended = false;
  let wake;
  const closedPromise = new Promise(resolve => { wake = resolve; });
  const end = reason => { if (!ended) { ended = true; wake(reason); } };
  const release = async () => {
    try { if (channel) await channel.close(); } catch { /* already closed */ }
    try { if (connection) await connection.close(); } catch { /* already closed */ }
  };
  let consumerTag;
  try {
    connection = await amqp.connect(amqpUrl);
    connection.on("error", error => log({ event: "broker_connection_error", kind: error?.code ?? error?.name ?? "error" }));
    connection.on("close", () => end("connection_closed"));
    channel = await connection.createChannel();
    channel.on("error", error => log({ event: "broker_channel_error", kind: error?.code ?? error?.name ?? "error" }));
    channel.on("close", () => end("channel_closed"));
    try {
      await assertConsumerTopology(channel, { deliveryLimit });
    } catch (error) {
      // e.g. 406 PRECONDITION_FAILED: incompatible existing queue. Reported, never auto-deleted.
      throw new ConsumerSetupError(`incompatible or unavailable RabbitMQ topology for ${QUEUE}: ${error?.message ?? error}`, error);
    }
    await channel.prefetch(prefetch);
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    ({ consumerTag } = await channel.consume(QUEUE, async message => {
      if (!message) { log({ event: "consumer_cancelled_by_broker" }); end("cancelled_by_broker"); return; }
      const messageId = message.properties.messageId;
      let envelope;
      try {
        envelope = parseEnvelope(message.content, messageId);
        const result = await inbox.handle(envelope);
        if (!ended) channel.ack(message);
        log({ event: result.duplicate ? "event_duplicate_skipped" : "event_processed", event_id: envelope.event_id, event_type: envelope.event_type, effects: result.effects });
      } catch (error) {
        if (ended) return; // unacked messages are redelivered by the broker
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
    closed: closedPromise,
    async close() {
      end("closed_by_caller");
      try { await channel.cancel(consumerTag); } catch { /* channel gone or consumer cancelled */ }
      await release();
    },
  };
}

// Keeps exactly one live subscription, reconnecting with bounded backoff after any end.
export function superviseConsumer({ amqpUrl, inbox, log = () => {}, minDelayMs = 500, maxDelayMs = 10000, ...options }) {
  let stopping = false;
  let current = null;
  let wakeSleep = () => {};
  const sleep = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); wakeSleep = () => { clearTimeout(timer); resolve(); }; });
  const done = (async () => {
    let delay = minDelayMs;
    while (!stopping) {
      try {
        current = await startConsumer({ amqpUrl, inbox, log, ...options });
        if (stopping) { await current.close(); current = null; break; }
        log({ event: "consumer_started" });
        delay = minDelayMs;
        const reason = await current.closed;
        await current.close(); // after a broker cancel the connection/channel are still open
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
    done,
    async stop() { stopping = true; wakeSleep(); if (current) await current.close(); await done; },
  };
}
