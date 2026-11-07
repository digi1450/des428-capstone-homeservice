// Area C: wallet provisioning consumer (provider.registered -> provisionWallet, deduped per consumer).
// Pure validation runs everywhere; the PostgreSQL and RabbitMQ cases are opt-in on DISPOSABLE
// services (TEST_DATABASE_URL, TEST_AMQP_URL).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import amqp from "amqplib";
import { createDatabase } from "../src/database.js";
import { migrate } from "../src/migrations.js";
import { createPaymentsService } from "../src/service.js";
import { parseEnvelope, PermanentEventError } from "../src/messaging/inbound.js";
import { createWalletInbox, startWalletConsumer, EVENTS_EXCHANGE, QUEUE, DEAD_LETTER_QUEUE, CONSUMER_NAME } from "../src/messaging/wallet-consumer.js";

const envelope = (providerId, overrides = {}) => ({
  event_id: randomUUID(), event_type: "provider.registered", schema_version: 1, producer: "monolith",
  occurred_at: new Date().toISOString(), aggregate_type: "provider", aggregate_id: String(providerId),
  saga_id: null, correlation_id: null, data: { provider_id: providerId }, ...overrides,
});
const fakeDatabase = { withTransaction: async () => { throw new Error("must not reach the database"); } };

test("rejects (permanently) wrong producer, unsupported type, and data that does not name one provider", async () => {
  const inbox = createWalletInbox(fakeDatabase, { provisionWallet: async () => {} });
  for (const bad of [
    envelope(7, { producer: "payments-wallet" }),
    envelope(7, { event_type: "provider.approved" }),
    envelope(7, { data: { provider_id: "7" } }),
    envelope(7, { data: { provider_id: 0 } }),
    envelope(7, { aggregate_id: "8" }),
    envelope(7, { aggregate_type: "order" }),
  ]) await assert.rejects(inbox.handle(bad), PermanentEventError);
  assert.throws(() => parseEnvelope(Buffer.from("{"), undefined), PermanentEventError);
  assert.throws(() => parseEnvelope(Buffer.from(JSON.stringify({ ...envelope(7), extra: 1 }))), PermanentEventError);
  const good = envelope(7);
  assert.throws(() => parseEnvelope(Buffer.from(JSON.stringify(good)), randomUUID()), /message_id/);
  assert.deepEqual(parseEnvelope(Buffer.from(JSON.stringify(good)), good.event_id), good);
});

test("wallet inbox on PostgreSQL", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const db = createDatabase(process.env.TEST_DATABASE_URL);
  await migrate(db);
  const inbox = createWalletInbox(db, createPaymentsService(db));
  const wallets = async (id) => (await db.query("SELECT * FROM provider_wallets WHERE provider_id=$1", [id])).rows;
  const dedupe = async (eventId) => (await db.query("SELECT * FROM processed_events WHERE consumer_name=$1 AND event_id=$2", [CONSUMER_NAME, eventId])).rows;
  t.after(() => db.close());

  await t.test("first delivery provisions one wallet; a redelivery is a duplicate with no effect", async () => {
    const id = randomInt(700000000, 710000000);
    const event = envelope(id);
    assert.deepEqual(await inbox.handle(event), { duplicate: false, effects: 1 });
    assert.deepEqual(await inbox.handle(event), { duplicate: true, effects: 0 });
    const rows = await wallets(id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].balance_cents, 0);
    assert.equal((await dedupe(event.event_id)).length, 1);
  });

  await t.test("5 concurrent deliveries of one event: one dedupe row, one wallet", async () => {
    const id = randomInt(710000000, 720000000);
    const event = envelope(id);
    const results = await Promise.all(Array.from({ length: 5 }, () => inbox.handle(event)));
    assert.equal(results.filter((r) => !r.duplicate).length, 1);
    assert.equal((await wallets(id)).length, 1);
  });

  await t.test("an existing wallet (legacy import) is kept unchanged", async () => {
    const id = randomInt(720000000, 730000000);
    await db.query("INSERT INTO provider_wallets (provider_id, balance_cents, commission_owed_cents) VALUES ($1, 850, 150)", [id]);
    await inbox.handle(envelope(id));
    const [row] = await wallets(id);
    assert.equal(row.balance_cents, 850);
    assert.equal(row.commission_owed_cents, 150);
  });

  await t.test("failure inside the effect rolls back the dedupe row, so the redelivery applies it", async () => {
    const id = randomInt(730000000, 740000000);
    const event = envelope(id);
    const failing = createWalletInbox(db, { provisionWallet: async () => { throw new Error("simulated database failure"); } });
    await assert.rejects(failing.handle(event), /simulated/);
    assert.equal((await dedupe(event.event_id)).length, 0);
    assert.deepEqual(await inbox.handle(event), { duplicate: false, effects: 1 });
    assert.equal((await wallets(id)).length, 1);
  });
});

test("wallet consumer with RabbitMQ: restart, duplicates and dead-lettering", { skip: !process.env.TEST_DATABASE_URL || !process.env.TEST_AMQP_URL }, async (t) => {
  const db = createDatabase(process.env.TEST_DATABASE_URL);
  await migrate(db);
  const inbox = createWalletInbox(db, createPaymentsService(db));
  const connection = await amqp.connect(process.env.TEST_AMQP_URL);
  const channel = await connection.createConfirmChannel();
  t.after(async () => { await channel.close(); await connection.close(); await db.close(); });
  const publish = (event, messageId = event.event_id) => new Promise((resolve, reject) => channel.publish(EVENTS_EXCHANGE, event.event_type,
    Buffer.from(JSON.stringify(event)), { persistent: true, messageId, contentType: "application/json", mandatory: true }, (error) => error ? reject(error) : resolve()));
  const wallets = async (id) => (await db.query("SELECT count(*)::int AS n FROM provider_wallets WHERE provider_id=$1", [id])).rows[0].n;
  const eventually = async (check, label) => {
    for (let i = 0; i < 100; i += 1) { if (await check()) return; await new Promise((r) => setTimeout(r, 50)); }
    assert.fail(`timed out waiting for ${label}`);
  };
  const consumer = await startWalletConsumer({ amqpUrl: process.env.TEST_AMQP_URL, inbox, retryDelayMs: 50 });
  await channel.purgeQueue(DEAD_LETTER_QUEUE);

  const a = randomInt(740000000, 750000000);
  const first = envelope(a);
  await publish(first);
  await publish(first); // duplicate delivery of the same event_id
  await eventually(async () => (await wallets(a)) === 1, "wallet a");

  // Consumer down: the event waits in the durable queue, then is applied after restart.
  await consumer.close();
  const b = randomInt(750000000, 760000000);
  await publish(envelope(b));
  assert.equal((await channel.checkQueue(QUEUE)).messageCount, 1, "retained while the consumer is down");
  assert.equal(await wallets(b), 0);
  const restarted = await startWalletConsumer({ amqpUrl: process.env.TEST_AMQP_URL, inbox, retryDelayMs: 50 });
  t.after(() => restarted.close());
  await eventually(async () => (await wallets(b)) === 1, "wallet b after restart");

  // Forged producer goes to this consumer's own DLQ, not applied.
  const c = randomInt(760000000, 770000000);
  await publish(envelope(c, { producer: "payments-wallet" }));
  await eventually(async () => (await channel.checkQueue(DEAD_LETTER_QUEUE)).messageCount === 1, "dead-lettered");
  assert.equal(await wallets(c), 0);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM processed_events WHERE consumer_name=$1 AND event_id=$2", [CONSUMER_NAME, first.event_id])).rows[0].n, 1);
});
