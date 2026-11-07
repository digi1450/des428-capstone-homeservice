import { test } from "node:test";
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { parseEnvelope, PermanentEventError } from "../src/messaging/envelope.js";
import { createInbox, CONSUMER_NAME } from "../src/messaging/inbox.js";
import { createDatabase } from "../src/database.js";
import { migrate } from "../src/migrations.js";

const envelope = (overrides = {}) => ({
  event_id: randomUUID(), event_type: "payment.succeeded", schema_version: 1, producer: "payments-wallet",
  occurred_at: new Date().toISOString(), aggregate_type: "order", aggregate_id: "42", saga_id: null, correlation_id: null,
  data: { order_id: 42, customer_id: 7, provider_id: 3, amount_cents: 100 }, ...overrides,
});
const body = value => Buffer.from(JSON.stringify(value));

test("parseEnvelope accepts the v1 envelope and rejects anything retrying cannot fix", () => {
  const value = envelope();
  assert.equal(parseEnvelope(body(value), value.event_id).event_id, value.event_id);
  assert.throws(() => parseEnvelope(Buffer.from("not json")), PermanentEventError);
  assert.throws(() => parseEnvelope(body(value), randomUUID()), /message_id/);
  for (const bad of [{ schema_version: 2 }, { event_id: "1" }, { producer: "browser" }, { data: [] }, { extra: true }, { occurred_at: "yesterday" }]) {
    assert.throws(() => parseEnvelope(body({ ...value, ...bad })), PermanentEventError, JSON.stringify(bad));
  }
});

test("inbox rejects unsupported events and the wrong producer before touching the database", async () => {
  const inbox = createInbox({ withTransaction: () => assert.fail("no SQL expected") }, { writer: {} });
  await assert.rejects(inbox.handle(envelope({ event_type: "order.placed" })), PermanentEventError);
  await assert.rejects(inbox.handle(envelope({ producer: "monolith" })), /must come from payments-wallet/);
});

// Explicit opt-in: a disposable PostgreSQL database for this service only.
test("inbox with PostgreSQL: one effect per event per consumer, atomic with its dedupe record", { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const db = createDatabase(process.env.TEST_DATABASE_URL);
  const providerId = randomInt(600000000, 700000000);
  const eventIds = [];
  const make = overrides => { const value = envelope({ data: { order_id: 42, customer_id: 7, provider_id: providerId, amount_cents: 100 }, ...overrides }); eventIds.push(value.event_id); return value; };
  const notificationCount = async () => (await db.query("SELECT count(*)::int AS n FROM notifications WHERE recipient_role = 'provider' AND recipient_id = $1", [providerId])).rows[0].n;
  const processed = async id => (await db.query("SELECT * FROM processed_events WHERE event_id = $1", [id])).rows;
  try {
    await migrate(db);
    await db.checkReady();
    const inbox = createInbox(db);

    await t.test("the same event delivered twice creates one notification", async () => {
      const event = make();
      assert.deepEqual(await inbox.handle(event), { duplicate: false, effects: 1 });
      assert.deepEqual(await inbox.handle(event), { duplicate: true, effects: 0 });
      assert.equal(await notificationCount(), 1);
      const rows = await processed(event.event_id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].consumer_name, CONSUMER_NAME);
      assert.equal(rows[0].effect_count, 1);
    });

    await t.test("concurrent duplicate deliveries still produce one effect", async () => {
      const before = await notificationCount();
      const event = make();
      const results = await Promise.all(Array.from({ length: 5 }, () => inbox.handle(event)));
      assert.equal(results.filter(r => !r.duplicate).length, 1);
      assert.equal(await notificationCount(), before + 1);
    });

    await t.test("dedupe is scoped per consumer: another consumer still applies its own effect", async () => {
      const event = make();
      await inbox.handle(event);
      const other = createInbox(db, { consumerName: "test.other-consumer", writer: { recordEvent: async () => [] } });
      assert.deepEqual(await other.handle(event), { duplicate: false, effects: 0 });
      assert.equal((await processed(event.event_id)).length, 2);
    });

    await t.test("invalid data is permanent and leaves no dedupe record or notification", async () => {
      const before = await notificationCount();
      const event = make({ data: { order_id: 42, provider_id: providerId, amount_cents: -5 } });
      await assert.rejects(inbox.handle(event), PermanentEventError);
      assert.equal((await processed(event.event_id)).length, 0);
      assert.equal(await notificationCount(), before);
    });

    await t.test("a failure after the dedupe insert rolls both back, so a retry can still succeed", async () => {
      const before = await notificationCount();
      const event = make();
      let calls = 0;
      const flaky = createInbox(db, { writer: { recordEvent: async (type, data, { client }) => {
        calls += 1;
        await client.query("INSERT INTO notifications (recipient_role, recipient_id, type, title, body, order_id) VALUES ('provider', $1, 'payment_received', 't', 'b', 42)", [providerId]);
        if (calls === 1) throw new Error("database connection lost");
        return [{}];
      } } });
      await assert.rejects(flaky.handle(event), /connection lost/);
      assert.equal((await processed(event.event_id)).length, 0);
      assert.equal(await notificationCount(), before);
      assert.deepEqual(await flaky.handle(event), { duplicate: false, effects: 1 });
      assert.equal(await notificationCount(), before + 1);
    });
  } finally {
    try {
      await db.query("DELETE FROM processed_events WHERE event_id = ANY($1::uuid[])", [eventIds]);
      await db.query("DELETE FROM notifications WHERE recipient_role = 'provider' AND recipient_id = $1", [providerId]);
    } finally { await db.close(); }
  }
});
