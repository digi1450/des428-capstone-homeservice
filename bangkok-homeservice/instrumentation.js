// Next.js boot hook. Runs once when the server process starts (dev and production alike). This is
// where the monolith gets its deterministic behaviour: a fresh, migrated, seeded database on every
// boot, and the outbox relay draining domain events in the background.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootstrapDb } = await import("./lib/db/bootstrap.js");
    bootstrapDb();
    const { startRelay } = await import("./lib/modules/notifications/relay.js");
    startRelay();
    // Area C: publish owned domain events to RabbitMQ only when a broker is configured.
    if (process.env.AMQP_URL) {
      const { startBrokerRelay } = await import("./lib/messaging/broker-relay.js");
      startBrokerRelay({ amqpUrl: process.env.AMQP_URL });
      const { startConsumers } = await import("./lib/messaging/consumers.js");
      startConsumers({ amqpUrl: process.env.AMQP_URL });
    }
  }
}
