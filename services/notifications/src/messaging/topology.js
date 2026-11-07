// Area C — RabbitMQ topology for the Notifications consumer (DRAFT, see docs/c-messaging-handoff.md).
// Producers publish to the durable topic exchange with routing key = event_type.
// This consumer owns its queue (publish-subscribe: other consumers bind their own
// queues to the same exchange and each receives every event).
export const EVENTS_EXCHANGE = "homeservice.events";
// Direct exchange: each consumer queue dead-letters with its own queue name as the routing key,
// so every consumer has a separate DLQ (a shared fanout would mix them).
export const DEAD_LETTER_EXCHANGE = "homeservice.dead-letter";
export const QUEUE = "notifications.events";
export const DEAD_LETTER_QUEUE = "notifications.events.dlq";
export const BINDINGS = Object.freeze([
  "payment.succeeded", "booking.status_changed", "booking.completed",
  "bid.accepted", "review.created", "provider.approved",
]);

export async function assertConsumerTopology(channel, { deliveryLimit = 5 } = {}) {
  await channel.assertExchange(EVENTS_EXCHANGE, "topic", { durable: true });
  await channel.assertExchange(DEAD_LETTER_EXCHANGE, "direct", { durable: true });
  await channel.assertQueue(DEAD_LETTER_QUEUE, { durable: true, arguments: { "x-queue-type": "quorum" } });
  await channel.bindQueue(DEAD_LETTER_QUEUE, DEAD_LETTER_EXCHANGE, QUEUE);
  // Quorum queue: counts redeliveries and dead-letters a message after deliveryLimit
  // transient failures (a poison message cannot block the queue forever).
  await channel.assertQueue(QUEUE, { durable: true, arguments: {
    "x-queue-type": "quorum",
    "x-delivery-limit": deliveryLimit,
    "x-dead-letter-exchange": DEAD_LETTER_EXCHANGE,
    "x-dead-letter-routing-key": QUEUE,
  } });
  for (const key of BINDINGS) await channel.bindQueue(QUEUE, EVENTS_EXCHANGE, key);
}
