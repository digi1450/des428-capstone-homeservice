// Area C — RabbitMQ names shared by producers and consumers (DRAFT, see docs/c-messaging-handoff.md).
// One durable topic exchange; the routing key is the event_type.
export const EVENTS_EXCHANGE = "homeservice.events";

export async function assertProducerTopology(channel) {
  await channel.assertExchange(EVENTS_EXCHANGE, "topic", { durable: true });
}
