import {startWorkerHealth} from './worker-health.js';
// Area C — outbox relay process for Payments & Wallet.
//   node src/outbox-relay.js   (DATABASE_URL, AMQP_URL; optional RELAY_POLL_MS, RELAY_BATCH_SIZE, RELAY_LEASE_MS)
// Runs separately from the HTTP server so it can be stopped/killed on its own:
// committed events wait in outbox_events until a relay publishes them.
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./database.js";
import { relayOnce } from "./messaging/outbox.js";
import { createPublisher } from "./messaging/publisher.js";

function positive(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  return value;
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!process.env.AMQP_URL) throw new Error("AMQP_URL is required");
const pollMs = positive("RELAY_POLL_MS", 500);
const batchSize = positive("RELAY_BATCH_SIZE", 50);
const leaseMs = positive("RELAY_LEASE_MS", 30000);
const owner = `payments-relay:${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const log = fields => console.log(JSON.stringify({ service: "payments-wallet", component: "outbox-relay", ...fields }));

const database = createDatabase(process.env.DATABASE_URL);
let publisher = null;
let stopping = false;
const health=startWorkerHealth({database,isConnected:()=>!stopping && publisher!==null && !publisher.closed});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function loop() {
  let reconnectDelay = 500;
  log({ event: "relay_started", owner });
  while (!stopping) {
    try {
      if (!publisher || publisher.closed) {
        publisher = await createPublisher(process.env.AMQP_URL);
        reconnectDelay = 500;
        log({ event: "broker_connected" });
      }
      const result = await relayOnce({ database, publisher, owner, batchSize, leaseMs });
      if (result.claimed) log({ event: "relay_batch", ...result });
      if (result.claimed < batchSize) await sleep(pollMs);
    } catch (error) {
      // Never log connection strings; driver messages can contain them.
      log({ event: "relay_error", kind: error?.code ?? error?.name ?? "error" });
      if (publisher) { await publisher.close(); publisher = null; }
      await sleep(reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 10000);
    }
  }
}

async function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 10000);
  deadline.unref();
  try { await health.close(); if (publisher) await publisher.close(); await database.close(); } finally { clearTimeout(deadline); }
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
loop().catch(error => { log({ event: "relay_fatal", kind: error?.name ?? "error" }); process.exit(1); });
