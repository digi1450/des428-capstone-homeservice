// Must be the first import: gives the monolith an isolated in-memory SQLite database.
import { freshBoot, getDb } from "../../bangkok-homeservice/test-helpers/boot.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import amqp from "../../services/payments-wallet/node_modules/amqplib/channel_api.js";
import { registerProvider } from "../../bangkok-homeservice/test-helpers/auth.js";
import { relayOnce } from "../../bangkok-homeservice/lib/messaging/broker-relay.js";
import { createPublisher } from "../../bangkok-homeservice/lib/messaging/publisher.js";
import { envelopeFromRow } from "../../bangkok-homeservice/lib/messaging/envelope.js";
import { createDatabase } from "../../services/payments-wallet/src/database.js";
import { migrate } from "../../services/payments-wallet/src/migrations.js";
import { createPaymentsService } from "../../services/payments-wallet/src/service.js";
import { createWalletInbox, startWalletConsumer, assertWalletTopology, QUEUE, DEAD_LETTER_QUEUE } from "../../services/payments-wallet/src/messaging/wallet-consumer.js";

// Area C: provider registration in the monolith (SQLite outbox) -> RabbitMQ -> Payments & Wallet
// provisions exactly one wallet. Opt-in, DISPOSABLE database and broker only (purges the queues).
const env = process.env;
const enabled = env.TEST_PAYMENTS_DATABASE_URL && env.TEST_AMQP_URL;

async function eventually(check, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail("timed out waiting for " + label);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("a registered provider gets exactly one Payments wallet through the broker", { skip: !enabled }, async () => {
  freshBoot();
  const payments = createDatabase(env.TEST_PAYMENTS_DATABASE_URL);
  const logs = [];
  let consumer, publisher, admin, channel;
  const wallets = async (id) => (await payments.query("SELECT * FROM provider_wallets WHERE provider_id=$1", [id])).rows;
  try {
    await migrate(payments);
    admin = await amqp.connect(env.TEST_AMQP_URL);
    channel = await admin.createChannel();
    await assertWalletTopology(channel);
    await channel.purgeQueue(QUEUE);
    await channel.purgeQueue(DEAD_LETTER_QUEUE);
    getDb().prepare("UPDATE events SET published_at = 'seed' WHERE published_at IS NULL").run();
    publisher = await createPublisher(env.TEST_AMQP_URL);

    // 1. Payments consumer is DOWN while the provider registers and the relay publishes.
    const provider = await registerProvider();
    assert.equal(provider.reg.status, 201);
    const row = getDb().prepare("SELECT * FROM events WHERE type='provider.registered' AND aggregate_id=?").get(provider.id);
    const sent = await relayOnce({ publisher, owner: "it-wallet-relay" });
    assert.equal(sent.published, 1);
    assert.equal((await channel.checkQueue(QUEUE)).messageCount, 1, "waits durably for Payments");
    assert.equal((await wallets(provider.id)).length, 0);

    // 2. Payments consumer starts: the wallet is provisioned once.
    consumer = await startWalletConsumer({ amqpUrl: env.TEST_AMQP_URL, inbox: createWalletInbox(payments, createPaymentsService(payments)), retryDelayMs: 100, log: (e) => logs.push(e) });
    await eventually(async () => (await wallets(provider.id)).length === 1, "wallet provisioned");

    // 3. The relay republishes the SAME event (crash after publish): still one wallet.
    await publisher.publish(envelopeFromRow(row));
    await publisher.publish(envelopeFromRow(row));
    await eventually(() => logs.filter((e) => e.event === "event_duplicate_skipped" && e.event_id === row.event_uuid).length === 2, "duplicate skips");
    assert.equal((await wallets(provider.id)).length, 1);
    assert.equal((await channel.checkQueue(DEAD_LETTER_QUEUE)).messageCount, 0);
  } finally {
    if (consumer) await consumer.close();
    if (publisher) await publisher.close();
    if (channel) await channel.close();
    if (admin) await admin.close();
    await payments.close();
  }
});
