// Area C — wallet provisioning consumer process for Payments & Wallet.
//   node src/wallet-consumer.js   (DATABASE_URL, AMQP_URL; optional CONSUMER_PREFETCH, CONSUMER_DELIVERY_LIMIT, CONSUMER_RETRY_DELAY_MS)
// Separate from the HTTP server: while it (or the database) is down, provider.registered events
// wait durably in payments.events and are applied once it recovers.
import { createDatabase } from "./database.js";
import { createPaymentsService } from "./service.js";
import { createWalletInbox, startWalletConsumer } from "./messaging/wallet-consumer.js";

function positive(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  return value;
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!process.env.AMQP_URL) throw new Error("AMQP_URL is required");
const options = {
  prefetch: positive("CONSUMER_PREFETCH", 10),
  deliveryLimit: positive("CONSUMER_DELIVERY_LIMIT", 5),
  retryDelayMs: positive("CONSUMER_RETRY_DELAY_MS", 1000),
};
const log = (fields) => console.log(JSON.stringify({ service: "payments-wallet", component: "wallet-consumer", ...fields }));
const database = createDatabase(process.env.DATABASE_URL);
const inbox = createWalletInbox(database, createPaymentsService(database));
let consumer = null;
let stopping = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  let delay = 500;
  while (!stopping) {
    try {
      consumer = await startWalletConsumer({ amqpUrl: process.env.AMQP_URL, inbox, log, ...options });
      log({ event: "consumer_started" });
      delay = 500;
      await consumer.closed;
      if (!stopping) log({ event: "broker_disconnected" });
    } catch (error) {
      log({ event: "consumer_error", kind: error?.code ?? error?.name ?? "error" });
    }
    if (!stopping) { await sleep(delay); delay = Math.min(delay * 2, 10000); }
  }
}

async function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 10000);
  deadline.unref();
  try { if (consumer) await consumer.close(); await database.close(); } finally { clearTimeout(deadline); }
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
run().catch(() => process.exit(1));
