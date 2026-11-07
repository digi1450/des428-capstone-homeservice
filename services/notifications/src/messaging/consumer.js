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

export async function startConsumer({ amqpUrl, inbox, prefetch = 10, deliveryLimit = 5, retryDelayMs = 1000, log = () => {} }) {
  const connection = await amqp.connect(amqpUrl);
  const channel = await connection.createChannel();
  await assertConsumerTopology(channel, { deliveryLimit });
  await channel.prefetch(prefetch);
  let closed = false;
  const closedPromise = new Promise(resolve => {
    const done = () => { closed = true; resolve(); };
    connection.on("close", done);
    channel.on("close", done);
  });
  connection.on("error", () => {});
  channel.on("error", () => {});
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  const { consumerTag } = await channel.consume(QUEUE, async message => {
    if (!message) return; // broker cancelled the consumer
    const messageId = message.properties.messageId;
    let envelope;
    try {
      envelope = parseEnvelope(message.content, messageId);
      const result = await inbox.handle(envelope);
      if (!closed) channel.ack(message);
      log({ event: result.duplicate ? "event_duplicate_skipped" : "event_processed", event_id: envelope.event_id, event_type: envelope.event_type, effects: result.effects });
    } catch (error) {
      if (closed) return; // unacked messages are redelivered by the broker
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
