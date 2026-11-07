import { test } from "node:test";
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { buildEnvelope, traceHeaders } from "../src/messaging/envelope.js";
import { createOutbox, relayOnce } from "../src/messaging/outbox.js";
import { createDatabase } from "../src/database.js";
import { migrate } from "../src/migrations.js";
import { createPaymentsService } from "../src/service.js";

const sample = { event_type: "payment.succeeded", aggregate_type: "order", aggregate_id: 42, data: { order_id: 42, provider_id: 3, amount_cents: 100 } };

test("envelope: stable shape, string aggregate id, rejects unsafe or malformed events", () => {
  const envelope = buildEnvelope(sample, { correlationId: "req-1", sagaId: "saga-1" });
  assert.equal(envelope.schema_version, 1);
  assert.equal(envelope.producer, "payments-wallet");
  assert.equal(envelope.aggregate_id, "42");
  assert.equal(envelope.correlation_id, "req-1");
  assert.equal(envelope.saga_id, "saga-1");
  assert.notEqual(buildEnvelope(sample).event_id, buildEnvelope(sample).event_id);
  for (const bad of [
    { ...sample, event_type: "Payment Succeeded" },
    { ...sample, aggregate_id: "" },
    { ...sample, data: [] },
    { ...sample, data: { order_id: 1, otp: "1234" } },
    { ...sample, data: { nested: { access_token: "x" } } },
  ]) assert.throws(() => buildEnvelope(bad), TypeError);
  assert.deepEqual(traceHeaders({ requestId: "r1" }), { "x-request-id": "r1" });
  assert.throws(() => traceHeaders({ requestId: "a\r\nb" }), TypeError);
});

test("outbox.stage refuses to run without the business transaction client", async () => {
  await assert.rejects(createOutbox().stage(undefined, sample), /transaction client/);
});

// Explicit opt-in: a disposable PostgreSQL database for this service only.
test("outbox with PostgreSQL: atomic staging, relay marks, retries and republishes the same event_id", { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const db = createDatabase(process.env.TEST_DATABASE_URL);
  const outbox = createOutbox();
  const base = randomInt(500000000, 600000000);
  const ids = [];
  const orders = [];
  const row = async id => (await db.query("SELECT * FROM outbox_events WHERE event_id = $1", [id])).rows[0];
  try {
    await migrate(db);
    await db.checkReady();

    await t.test("business change and outbox row commit together, or roll back together", async () => {
      const committed = await db.withTransaction(client => outbox.stage(client, sample, { requestId: "req-a" }));
      ids.push(committed);
      const stored = await row(committed);
      assert.equal(stored.published_at, null);
      assert.equal(stored.envelope.event_id, committed);
      assert.deepEqual(stored.headers, { "x-request-id": "req-a" });
      let lost;
      await assert.rejects(db.withTransaction(async client => {
        lost = await outbox.stage(client, sample);
        throw new Error("business write failed after staging");
      }), /business write failed/);
      assert.equal(await row(lost), undefined);
    });

    await t.test("settleWebhook stages payment.succeeded atomically with the charge", async () => {
      const service = createPaymentsService(db, { assertSettlementAllowed: async () => true, stageEvent: outbox.stage });
      const order = base + 1;
      orders.push(order);
      const intent = await service.prepareIntent({ order_id: order, customer_id: base + 2, provider_id: base + 3, amount_cents: 2500, currency: "THB" });
      await service.settleWebhook({ gateway_event_id: "c-test-" + randomUUID(), type: "payment_intent.succeeded", gateway_ref: intent.gateway_ref });
      const staged = (await db.query("SELECT * FROM outbox_events WHERE aggregate_id = $1", [String(order)])).rows;
      assert.equal(staged.length, 1);
      ids.push(staged[0].event_id);
      assert.deepEqual(staged[0].envelope.data, { order_id: order, customer_id: base + 2, provider_id: base + 3, amount_cents: 2500 });
      const failing = createPaymentsService(db, { assertSettlementAllowed: async () => true,
        stageEvent: async (client, event) => { await outbox.stage(client, event); throw new Error("stage failed"); } });
      const other = base + 4;
      orders.push(other);
      const second = await failing.prepareIntent({ order_id: other, customer_id: base + 2, provider_id: base + 3, amount_cents: 10, currency: "THB" });
      await assert.rejects(failing.settleWebhook({ gateway_event_id: "c-test-" + randomUUID(), type: "payment_intent.succeeded", gateway_ref: second.gateway_ref }), /stage failed/);
      assert.equal((await db.query("SELECT 1 FROM outbox_events WHERE aggregate_id = $1", [String(other)])).rowCount, 0);
      assert.equal((await db.query("SELECT 1 FROM transactions WHERE order_id = $1", [other])).rowCount, 0);
    });

    // Isolate relay assertions from any older rows: only consider ids created here.
    const ours = new Set();
    const capture = () => {
      const sent = [];
      return { sent, publisher: { async publish(r) { if (ours.has(r.event_id)) sent.push(r.event_id); } } };
    };
    await db.query("UPDATE outbox_events SET published_at = now() WHERE published_at IS NULL AND NOT (event_id = ANY($1::uuid[]))", [ids]);
    ids.forEach(id => ours.add(id));

    await t.test("relay publishes pending rows in order and marks them published", async () => {
      const { sent, publisher } = capture();
      const result = await relayOnce({ database: db, publisher, owner: "test-relay" });
      assert.deepEqual(sent, ids);
      assert.ok(result.published >= ids.length);
      for (const id of ids) assert.notEqual((await row(id)).published_at, null);
      const again = capture();
      await relayOnce({ database: db, publisher: again.publisher, owner: "test-relay" });
      assert.deepEqual(again.sent, []);
    });

    await t.test("failed publish stays pending with backoff and is retried later", async () => {
      const id = await db.withTransaction(client => outbox.stage(client, sample));
      ids.push(id); ours.add(id);
      const failing = { async publish() { throw new Error("unroutable: no queue bound for payment.succeeded"); } };
      await relayOnce({ database: db, publisher: failing, owner: "test-relay" });
      const failed = await row(id);
      assert.equal(failed.published_at, null);
      assert.equal(failed.attempts, 1);
      assert.match(failed.last_error, /unroutable/);
      assert.ok(new Date(failed.next_attempt_at) > new Date());
      const { sent, publisher } = capture();
      await relayOnce({ database: db, publisher, owner: "test-relay" });
      assert.deepEqual(sent, [], "not retried before its backoff");
      await db.query("UPDATE outbox_events SET next_attempt_at = now() WHERE event_id = $1", [id]);
      await relayOnce({ database: db, publisher, owner: "test-relay" });
      assert.deepEqual(sent, [id]);
    });

    await t.test("two relays never claim the same row while its lease is live", async () => {
      const id = await db.withTransaction(client => outbox.stage(client, sample));
      ids.push(id); ours.add(id);
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const slow = { sent: [], async publish(r) { if (ours.has(r.event_id)) this.sent.push(r.event_id); await gate; } };
      const fast = capture();
      const first = relayOnce({ database: db, publisher: slow, owner: "relay-1" });
      await new Promise(resolve => setTimeout(resolve, 200));
      await relayOnce({ database: db, publisher: fast.publisher, owner: "relay-2" });
      release();
      await first;
      assert.deepEqual(slow.sent, [id]);
      assert.deepEqual(fast.sent, []);
    });

    await t.test("crash after publish, before mark: lease expires and the SAME event_id is published again", async () => {
      const id = await db.withTransaction(client => outbox.stage(client, sample));
      ids.push(id); ours.add(id);
      const crashed = { sent: [], async publish(r) { if (ours.has(r.event_id)) this.sent.push(r.event_id); throw Object.assign(new Error("process killed"), { simulatedCrash: true }); } };
      // Simulate the crash: the message reached the broker but the relay died before
      // updating the row, so the row keeps its lease and stays unpublished.
      await relayOnce({ database: db, publisher: crashed, owner: "dead-relay", leaseMs: 1000 });
      await db.query("UPDATE outbox_events SET locked_by = 'dead-relay', locked_until = now() + interval '1 second', next_attempt_at = now(), last_error = NULL WHERE event_id = $1", [id]);
      const { sent, publisher } = capture();
      await relayOnce({ database: db, publisher, owner: "new-relay" });
      assert.deepEqual(sent, [], "a live lease is respected");
      await new Promise(resolve => setTimeout(resolve, 1100));
      await relayOnce({ database: db, publisher, owner: "new-relay" });
      assert.deepEqual(crashed.sent, [id]);
      assert.deepEqual(sent, [id], "redelivered with the same event_id: consumers must dedupe");
      assert.notEqual((await row(id)).published_at, null);
    });
  } finally {
    try {
      await db.query("DELETE FROM outbox_events WHERE event_id = ANY($1::uuid[])", [ids]);
      await db.query("DELETE FROM outbox_events WHERE aggregate_id = ANY($1::text[])", [orders.map(String)]);
      await db.query("DELETE FROM webhook_events WHERE payload_json->>'gateway_ref' IN (SELECT gateway_ref FROM payment_intents WHERE order_id = ANY($1::integer[]))", [orders]);
      await db.query("DELETE FROM transactions WHERE order_id = ANY($1::integer[])", [orders]);
      await db.query("DELETE FROM payment_intents WHERE order_id = ANY($1::integer[])", [orders]);
    } finally { await db.close(); }
  }
});
