// Next.js boot hook. Runs once when the server process starts (dev and production alike). This is
// where an empty database is initialized, existing data is preserved, and the outbox relay starts.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { bootstrapDb } = await import("./lib/db/bootstrap.js");
      bootstrapDb();
    } catch (error) {
      // Next 14 can log a register() rejection and continue serving. Database initialization
      // is mandatory: terminate before relays or business requests can use an invalid schema.
      console.error("SQLite startup failed; refusing to serve requests.", error);
      process.exit(1);
    }
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
