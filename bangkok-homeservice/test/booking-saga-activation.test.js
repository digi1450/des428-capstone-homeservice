// Area C: monolith activation delivery for COMPLETED gateway sagas (interface §4).
// Payments is a contract-faithful fake behind A's real Booking adapter, plus an `activate`
// method with the agreed shape (A's adapter/client method is still pending). In-memory SQLite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshBoot, getDb } from "../test-helpers/boot.js";
import { call } from "../test-helpers/call.js";
import { loginSeededCustomer, loginSeededProvider, futureWeekday } from "../test-helpers/auth.js";
import * as bookings from "../app/api/bookings/route.js";
import { createBookingPaymentsAdapter } from "../lib/modules/booking/payment-adapter.js";
import { PaymentOutcomeUnknownError } from "../lib/modules/payments/client.js";
import { AppError } from "../lib/errors.js";
import { configureBookingSaga, recoverOnce, activate, paymentSetupFor, STATES, ACTIVATION, SETUP_CANCELLED } from "../lib/modules/booking/saga.js";

freshBoot();

function fakePayments() {
  let nextId = 1;
  const calls = { activate: [] };
  const activated = new Set();
  const mode = { activate: "ok" };
  const client = {
    async createIntent(ctx, credentials) {
      return { create_command_id: credentials.commandId, saga_id: ctx.saga_id, outcome: "created",
        payment_intent: { id: nextId++, order_id: ctx.order_id, amount_cents: ctx.amount_cents, gateway_ref: `SIM-PI-${nextId}`, status: "requires_payment" } };
    },
    async getOperation() { throw new Error("not used"); },
    async cancelIntent() { throw new Error("not used"); },
  };
  const adapter = createBookingPaymentsAdapter({ paymentsClient: client });
  adapter.activate = async (workflow) => {
    calls.activate.push(workflow);
    await new Promise((resolve) => setTimeout(resolve, 2));
    if (mode.activate === "timeout") throw new PaymentOutcomeUnknownError("activate", workflow.createCommandId, "timeout");
    if (mode.activate === "lost_reply") { activated.add(workflow.activateCommandId); throw new PaymentOutcomeUnknownError("activate", workflow.createCommandId, "timeout"); }
    if (mode.activate === "fenced") { const error = new AppError(409, "payment setup was cancelled"); error.code = SETUP_CANCELLED; throw error; }
    if (mode.activate === "conflict") throw new AppError(409, "no matching payment provisioning to activate");
    if (mode.activate === "conflict_unknown") throw new PaymentOutcomeUnknownError("activate", workflow.createCommandId, "unexpected_status", 409);
    activated.add(workflow.activateCommandId);
    return { create_command_id: workflow.createCommandId, saga_id: workflow.sagaId, outcome: "activated" };
  };
  return { adapter, calls, mode, activated };
}

const saga = (orderId) => getDb().prepare("SELECT * FROM booking_sagas WHERE order_id = ?").get(orderId);
const activation = (orderId) => getDb().prepare("SELECT a.* FROM booking_saga_activations a JOIN booking_sagas s USING (saga_id) WHERE s.order_id = ?").get(orderId);
const attention = (orderId) => getDb().prepare("SELECT reason FROM consistency_attention WHERE consumer_name = 'booking-saga' AND aggregate_id = ? ORDER BY id").all(String(orderId)).map((r) => r.reason);
const holds = (orderId) => getDb().prepare("SELECT count(*) AS n FROM slot_holds WHERE order_id = ?").get(orderId).n;
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("booking saga activation delivery", async (t) => {
  const customer = await loginSeededCustomer("nong@example.com");
  const provider = await loginSeededProvider("sparkle@example.com");
  const addressId = getDb().prepare("SELECT id FROM addresses WHERE customer_id = ? LIMIT 1").get(customer.id).id;
  let day = 12; // one date per booking: no slot clashes between subtests
  const request = (startingTime) => ({ provider_id: provider.id, address_id: addressId, service_date: futureWeekday((day += 2)),
    starting_time: startingTime, items: [{ service_id: 2, quantity: 1 }], payment_method: "gateway" });
  const place = (body, key) => call(bookings.POST, { token: customer.token, body, headers: { "idempotency-key": key } });
  const setup = (overrides = {}) => {
    const fake = fakePayments();
    configureBookingSaga({ payments: fake.adapter, baseBackoffMs: 1, maxBackoffMs: 1, activateEscalateAfter: 3, ...overrides });
    return fake;
  };

  await t.test("COMPLETED queues activation in the same transaction; without A's activate it stays pending", async () => {
    const fake = setup();
    delete fake.adapter.activate;
    const res = await place(request("10:00"), "a-unwired");
    assert.equal(res.status, 201);
    const orderId = res.body.order.id;
    assert.equal(saga(orderId).state, STATES.COMPLETED);
    const row = activation(orderId);
    assert.equal(row.state, ACTIVATION.PENDING);
    assert.equal(row.activate_command_id, `activate:${saga(orderId).saga_id}`);
    assert.equal(paymentSetupFor(orderId), "pending", "a provisioned booking is shown, payment not ready");
    await tick();
    assert.equal(await recoverOnce(), 0, "nothing is delivered while the adapter has no activate");
    // A's method appears later (deploy): recovery delivers the queued activation.
    const wired = setup();
    assert.equal(await recoverOnce(), 1);
    assert.equal(activation(orderId).state, ACTIVATION.ACTIVATED);
    assert.equal(paymentSetupFor(orderId), "ready");
    assert.deepEqual(wired.calls.activate, [{ createCommandId: saga(orderId).create_command_id, sagaId: saga(orderId).saga_id, activateCommandId: row.activate_command_id }]);
  });

  await t.test("first delivery happens right after COMPLETED; the replayed 201 does not re-deliver", async () => {
    const fake = setup();
    const body = request("10:00");
    const res = await place(body, "a-ok");
    const orderId = res.body.order.id;
    assert.equal(activation(orderId).state, ACTIVATION.ACTIVATED);
    const again = await place(body, "a-ok");
    assert.deepEqual(again.body, res.body, "the booking response is unchanged by activation");
    assert.equal(fake.calls.activate.length, 1);
  });

  await t.test("timeout and lost reply keep it pending and retry the SAME key; never cancels the booking", async () => {
    const fake = setup();
    fake.mode.activate = "timeout";
    const res = await place(request("10:00"), "a-timeout");
    assert.equal(res.status, 201, "a provisioned booking is booked even when activation is unconfirmed");
    const orderId = res.body.order.id;
    assert.equal(activation(orderId).state, ACTIVATION.PENDING);
    assert.equal(activation(orderId).attempts, 1);
    fake.mode.activate = "lost_reply";
    await tick(); await recoverOnce();
    assert.equal(activation(orderId).state, ACTIVATION.PENDING, "Payments activated it but the reply was lost");
    fake.mode.activate = "ok";
    await tick(); await recoverOnce();
    assert.equal(activation(orderId).state, ACTIVATION.ACTIVATED);
    assert.equal(new Set(fake.calls.activate.map((c) => c.activateCommandId)).size, 1, "one stable activation key");
    assert.equal(fake.calls.activate.length, 3);
    assert.equal(saga(orderId).state, STATES.COMPLETED);
    assert.ok(holds(orderId) > 0, "slots are never released by activation trouble");
    assert.deepEqual(attention(orderId), []);
  });

  await t.test("repeated unknown outcomes escalate once for visibility but stay pending (not ready)", async () => {
    const fake = setup();
    fake.mode.activate = "timeout";
    const orderId = (await place(request("10:00"), "a-escalate")).body.order.id;
    for (let i = 0; i < 4; i += 1) { await tick(); await recoverOnce(); }
    assert.equal(activation(orderId).state, ACTIVATION.PENDING);
    assert.equal(activation(orderId).attempts, 5);
    assert.deepEqual(attention(orderId), ["activation_unconfirmed"]);
    assert.equal(paymentSetupFor(orderId), "pending");
  });

  await t.test("coded PAYMENT_SETUP_CANCELLED: blocked + attention, no further delivery, never ready", async () => {
    const fake = setup();
    fake.mode.activate = "fenced";
    const orderId = (await place(request("10:00"), "a-fenced")).body.order.id;
    assert.equal(activation(orderId).state, ACTIVATION.BLOCKED);
    assert.deepEqual(attention(orderId), ["payment_setup_cancelled"]);
    assert.equal(paymentSetupFor(orderId), ACTIVATION.BLOCKED);
    fake.mode.activate = "ok";
    await tick(); await recoverOnce();
    assert.equal(activation(orderId).state, ACTIVATION.BLOCKED, "a blocked activation is not retried into success");
    assert.equal(fake.calls.activate.filter((c) => c.sagaId === saga(orderId).saga_id).length, 1);
    assert.equal(saga(orderId).state, STATES.COMPLETED, "local cancellation is a separate reconciled decision");
  });

  await t.test("uncoded conflicts (direct 409 or unknown with upstream 409) go to reconcile, not blocked", async () => {
    for (const [mode, key, time] of [["conflict", "a-conflict", "10:00"], ["conflict_unknown", "a-conflict-u", "10:00"]]) {
      const fake = setup();
      fake.mode.activate = mode;
      const orderId = (await place(request(time), key)).body.order.id;
      assert.equal(activation(orderId).state, ACTIVATION.RECONCILE, mode);
      assert.deepEqual(attention(orderId), ["activation_conflict"], mode);
      assert.notEqual(paymentSetupFor(orderId), "ready");
      assert.ok(holds(orderId) > 0, "an uncoded 409 is never treated as a fence");
    }
  });

  await t.test("lease: concurrent deliveries for one saga make a single call", async () => {
    const fake = setup();
    fake.mode.activate = "timeout";
    const orderId = (await place(request("10:00"), "a-lease")).body.order.id;
    fake.mode.activate = "ok";
    fake.calls.activate.length = 0;
    await tick();
    await Promise.all([activate(saga(orderId).saga_id), activate(saga(orderId).saga_id), recoverOnce()]);
    assert.equal(fake.calls.activate.filter((c) => c.sagaId === saga(orderId).saga_id).length, 1);
    assert.equal(activation(orderId).state, ACTIVATION.ACTIVATED);
  });

  // Review #29 P1: results are fenced by a per-claim token, so a worker whose lease expired cannot
  // overwrite (or release) a newer claim.
  const manual = (fake) => {
    const pending = [];
    fake.adapter.activate = (workflow) => new Promise((resolve, reject) => { fake.calls.activate.push(workflow); pending.push({ resolve, reject }); });
    return pending;
  };
  const expireLease = (sagaId) => getDb().prepare("UPDATE booking_saga_activations SET locked_until = '2000-01-01T00:00:00.000Z' WHERE saga_id = ?").run(sagaId);
  const fencedError = () => { const e = new AppError(409, "payment setup was cancelled"); e.code = SETUP_CANCELLED; return e; };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  await t.test("late old success after lease replacement cannot override the newer claim's fence", async () => {
    const fake = setup();
    fake.mode.activate = "timeout";
    const orderId = (await place(request("10:00"), "a-stale-ok")).body.order.id;
    const sagaId = saga(orderId).saga_id;
    const pending = manual(fake);
    await tick();
    const workerA = activate(sagaId);
    await settle();
    const tokenA = activation(orderId).locked_by;
    expireLease(sagaId);
    const workerB = activate(sagaId);
    await settle();
    const tokenB = activation(orderId).locked_by;
    assert.notEqual(tokenB, tokenA, "each claim has its own token, even in one process");
    pending[0].resolve({ outcome: "activated" }); // A's late success
    await workerA;
    assert.equal(activation(orderId).state, ACTIVATION.PENDING, "stale success discarded");
    assert.equal(activation(orderId).locked_by, tokenB, "stale worker did not release the newer lease");
    pending[1].reject(fencedError());
    await workerB;
    assert.equal(activation(orderId).state, ACTIVATION.BLOCKED);
    assert.equal(paymentSetupFor(orderId), ACTIVATION.BLOCKED, "never falsely ready");
    assert.deepEqual(attention(orderId), ["payment_setup_cancelled"]);
  });

  await t.test("late old unknown / conflict / fence after lease replacement change nothing", async () => {
    for (const [late, key] of [[() => new PaymentOutcomeUnknownError("activate", "x", "timeout"), "a-stale-unknown"],
      [() => new AppError(409, "uncoded"), "a-stale-conflict"], [fencedError, "a-stale-fence"]]) {
      const fake = setup();
      fake.mode.activate = "timeout";
      const orderId = (await place(request("10:00"), key)).body.order.id;
      const sagaId = saga(orderId).saga_id;
      const attemptsBefore = activation(orderId).attempts;
      const pending = manual(fake);
      await tick();
      const workerA = activate(sagaId);
      await settle();
      expireLease(sagaId);
      const workerB = activate(sagaId);
      await settle();
      pending[0].reject(late());
      await workerA;
      assert.equal(activation(orderId).state, ACTIVATION.PENDING, key);
      assert.equal(activation(orderId).attempts, attemptsBefore, `${key}: no stale retry bookkeeping`);
      assert.deepEqual(attention(orderId), [], `${key}: no stale attention`);
      pending[1].resolve({ outcome: "activated" });
      await workerB;
      assert.equal(activation(orderId).state, ACTIVATION.ACTIVATED, key);
    }
  });

  // Review #29 P2: the code alone is not a fence; it must arrive on a validated 409.
  await t.test("a cancellation code on a non-409 error stays pending (unconfirmed), not blocked", async () => {
    const coded503 = () => { const e = new AppError(503, "unconfirmed"); e.code = SETUP_CANCELLED; return e; };
    const codedUnknown = () => { const e = new PaymentOutcomeUnknownError("activate", "x", "timeout"); e.code = SETUP_CANCELLED; return e; };
    const codedUnknown409 = () => { const e = new PaymentOutcomeUnknownError("activate", "x", "unexpected_status", 409); e.code = SETUP_CANCELLED; return e; };
    for (const [make, key, expected] of [[coded503, "a-coded-503", ACTIVATION.PENDING], [codedUnknown, "a-coded-unknown", ACTIVATION.PENDING],
      [codedUnknown409, "a-coded-409", ACTIVATION.BLOCKED], [fencedError, "a-coded-409-direct", ACTIVATION.BLOCKED]]) {
      const fake = setup();
      fake.adapter.activate = async () => { throw make(); };
      const orderId = (await place(request("10:00"), key)).body.order.id;
      assert.equal(activation(orderId).state, expected, key);
      if (expected === ACTIVATION.PENDING) {
        assert.equal(activation(orderId).attempts, 1, `${key}: retried later with the same key`);
        assert.deepEqual(attention(orderId), []);
      }
    }
  });

  await t.test("restart: a new runtime delivers activation left pending by a dead process", async () => {
    const fake = setup();
    fake.mode.activate = "timeout";
    const orderId = (await place(request("10:00"), "a-restart")).body.order.id;
    // The dead process held a lease that has since expired.
    getDb().prepare("UPDATE booking_saga_activations SET locked_by = 'dead-worker', locked_until = '2000-01-01T00:00:00.000Z' WHERE saga_id = ?").run(saga(orderId).saga_id);
    const next = setup();
    await tick();
    assert.ok(await recoverOnce() >= 1);
    assert.equal(activation(orderId).state, ACTIVATION.ACTIVATED);
    assert.equal(next.calls.activate.find((c) => c.sagaId === saga(orderId).saga_id).activateCommandId, `activate:${saga(orderId).saga_id}`);
    assert.equal(activation(orderId).locked_by, null);
  });
});
