// Area C: Booking-orchestrated provisioning saga. Payments is a contract-faithful fake behind A's
// real Booking payments adapter: a create command replays its stored result, and a confirmed
// cancel-by-command fences the create so it can never commit later. No network, in-memory SQLite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshBoot, getDb } from "../test-helpers/boot.js";
import { call } from "../test-helpers/call.js";
import { loginSeededCustomer, loginSeededProvider, registerCustomer, futureWeekday } from "../test-helpers/auth.js";
import * as bookings from "../app/api/bookings/route.js";
import { createBookingPaymentsAdapter } from "../lib/modules/booking/payment-adapter.js";
import { PaymentOutcomeUnknownError } from "../lib/modules/payments/client.js";
import { configureBookingSaga, resetBookingSaga, recoverOnce, transitions, STATES } from "../lib/modules/booking/saga.js";

freshBoot();

function fakePayments() {
  const operations = new Map(); // create_command_id -> { outcome, intent }
  const calls = { create: [], cancel: [] };
  let nextId = 1;
  const mode = { create: "ok", cancel: "ok" };
  const unknown = (op, id, reason) => new PaymentOutcomeUnknownError(op, id, reason);
  const client = {
    async createIntent(ctx, credentials) {
      const id = credentials.commandId;
      calls.create.push(id);
      const existing = operations.get(id);
      if (mode.create === "timeout") throw unknown("create", id, "timeout");
      if (existing?.outcome === "cancelled") throw unknown("create", id, "mismatched_response"); // fenced: no intent
      const op = existing ?? { outcome: "created", intent: { id: nextId++, order_id: ctx.order_id, amount_cents: ctx.amount_cents, gateway_ref: `SIM-PI-fake-${id}`, status: "requires_payment" } };
      operations.set(id, op);
      if (mode.create === "lost_reply") throw unknown("create", id, "timeout"); // committed, reply lost
      return { create_command_id: id, saga_id: ctx.saga_id, outcome: "created", payment_intent: op.intent };
    },
    async getOperation() { throw new Error("not used"); },
    async cancelIntent(ctx, credentials) {
      calls.cancel.push(credentials.commandId);
      if (mode.cancel === "fail") throw unknown("cancel", ctx.create_command_id, "timeout");
      const op = operations.get(ctx.create_command_id);
      if (op?.intent) op.intent = { ...op.intent, status: "failed" }; // void the unpaid intent
      operations.set(ctx.create_command_id, { ...op, outcome: "cancelled" });
      return { create_command_id: ctx.create_command_id, saga_id: ctx.saga_id, outcome: "cancelled" };
    },
  };
  const intentsFor = (orderId) => [...operations.values()].filter((o) => o.intent?.order_id === orderId);
  return { adapter: createBookingPaymentsAdapter({ paymentsClient: client }), calls, mode, operations, intentsFor };
}

const saga = (orderId) => getDb().prepare("SELECT * FROM booking_sagas WHERE order_id = ?").get(orderId);
const holds = (orderId) => getDb().prepare("SELECT count(*) AS n FROM slot_holds WHERE order_id = ?").get(orderId).n;
const placedEvents = (orderId) => getDb().prepare("SELECT count(*) AS n FROM events WHERE type = 'booking.status_changed' AND aggregate_id = ?").get(orderId).n;
const localIntents = (orderId) => getDb().prepare("SELECT count(*) AS n FROM payment_intents WHERE order_id = ?").get(orderId).n;

test("booking-orchestrated saga", async (t) => {
  const customer = await loginSeededCustomer("nong@example.com");
  const provider = await loginSeededProvider("sparkle@example.com");
  const addressId = getDb().prepare("SELECT id FROM addresses WHERE customer_id = ? LIMIT 1").get(customer.id).id;
  const date = futureWeekday(8);
  const request = (startingTime, extra = {}) => ({ provider_id: provider.id, address_id: addressId, service_date: date,
    starting_time: startingTime, items: [{ service_id: 2, quantity: 1 }], payment_method: "gateway", ...extra });
  const place = (body, key, token = customer.token) => call(bookings.POST, { token, body, headers: key ? { "idempotency-key": key } : {} });
  const setup = (overrides = {}) => {
    const fake = fakePayments();
    configureBookingSaga({ payments: fake.adapter, baseBackoffMs: 1, maxBackoffMs: 1, maxCreateAttempts: 3, maxCancelAttempts: 2, ...overrides });
    return fake;
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  await t.test("not configured: gateway bookings keep the inherited flow", async () => {
    resetBookingSaga();
    const res = await place(request("09:00"));
    assert.equal(res.status, 201);
    assert.equal(saga(res.body.order.id), undefined);
    assert.equal(localIntents(res.body.order.id), 1);
  });

  await t.test("success: reserve, create intent remotely, finalize; a retry replays the same 201", async () => {
    const fake = setup();
    const res = await place(request("11:00"), "k-success");
    assert.equal(res.status, 201);
    const orderId = res.body.order.id;
    assert.equal(res.body.order.status, "awaiting");
    assert.equal(res.body.payment_intent.order_id, orderId);
    assert.equal(saga(orderId).state, STATES.COMPLETED);
    assert.equal(placedEvents(orderId), 1, "the awaiting event is written only once provisioning completes");
    assert.equal(localIntents(orderId), 0, "no SQLite payment intent on the saga path");
    assert.deepEqual(transitions(saga(orderId).saga_id).map((x) => x.to_state), [STATES.CREATE_PENDING, STATES.COMPLETED]);
    const again = await place(request("11:00"), "k-success");
    assert.equal(again.status, 201);
    assert.deepEqual(again.body, res.body);
    assert.equal(getDb().prepare("SELECT count(*) AS n FROM booking_sagas WHERE request_key = 'k-success'").get().n, 1);
    assert.equal(fake.calls.create.length, 1);
    const changed = await place(request("13:00"), "k-success");
    assert.equal(changed.status, 409, "same key, different request");
  });

  await t.test("timeout: 503 pending keeps the slots and command; recovery completes with ONE intent", async () => {
    const fake = setup();
    fake.mode.create = "timeout";
    const res = await place(request("13:00"), "k-timeout");
    assert.equal(res.status, 503);
    assert.equal(res.body.code, "BOOKING_PENDING");
    assert.equal(res.headers.get("retry-after"), "2");
    assert.equal(res.headers.get("location"), null, "no Location until the booking exists for the customer");
    const orderId = res.body.order_id;
    assert.equal(saga(orderId).state, STATES.CREATE_PENDING);
    assert.ok(holds(orderId) > 0, "a timeout never releases slots");
    assert.equal(placedEvents(orderId), 0);
    const other = await registerCustomer();
    const clash = await place(request("13:00", { address_id: undefined }), "k-other", other.token);
    assert.equal(clash.status, 409, "the held slot cannot be taken meanwhile");
    fake.mode.create = "ok";
    await tick();
    assert.equal(await recoverOnce(), 1);
    assert.equal(saga(orderId).state, STATES.COMPLETED);
    assert.equal(new Set(fake.calls.create).size, 1, "every attempt reused the same create command");
    assert.equal(fake.intentsFor(orderId).length, 1);
    const replay = await place(request("13:00"), "k-timeout");
    assert.equal(replay.status, 201);
    assert.equal(replay.body.order.id, orderId);
  });

  await t.test("lost reply after the intent was created: the retry replays it, still one intent", async () => {
    const fake = setup();
    fake.mode.create = "lost_reply";
    const res = await place(request("15:00"), "k-lost");
    assert.equal(res.status, 503);
    const orderId = res.body.order_id;
    assert.equal(fake.intentsFor(orderId).length, 1, "Payments did create it");
    fake.mode.create = "ok";
    await tick();
    const retry = await place(request("15:00"), "k-lost");
    assert.equal(retry.status, 201);
    assert.equal(fake.intentsFor(orderId).length, 1);
    assert.equal(retry.body.payment_intent.id, fake.intentsFor(orderId)[0].intent.id);
  });

  await t.test("payments keeps failing: compensation fences the create, then cancels and releases slots", async () => {
    const fake = setup();
    fake.mode.create = "timeout";
    const res = await place(request("09:00", { service_date: futureWeekday(10) }), "k-fail");
    const orderId = res.body.order_id;
    const heldBefore = holds(orderId);
    for (let i = 0; i < 3; i += 1) { await tick(); await recoverOnce(); }
    assert.equal(saga(orderId).state, STATES.CANCELLED);
    assert.equal(fake.calls.cancel.length, 1);
    assert.equal(fake.calls.cancel[0], saga(orderId).cancel_command_id);
    const order = getDb().prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
    assert.equal(order.status, "cancelled", "the booking row is kept as history");
    assert.ok(heldBefore > 0);
    assert.equal(holds(orderId), 0, "slots released only after the fence was confirmed");
    assert.equal(placedEvents(orderId), 0);
    assert.deepEqual(transitions(saga(orderId).saga_id).map((x) => x.to_state),
      [STATES.CREATE_PENDING, STATES.COMPENSATION_PENDING, STATES.CANCELLED]);
    fake.mode.create = "ok";
    await assert.rejects(fake.adapter.prepare({ ...JSON.parse(saga(orderId).snapshot_json) },
      { createCommandId: saga(orderId).create_command_id, sagaId: saga(orderId).saga_id }, {}), PaymentOutcomeUnknownError);
    assert.equal(fake.intentsFor(orderId).length, 0, "a late create after the fence produces no intent");
    const retry = await place(request("09:00", { service_date: futureWeekday(10) }), "k-fail");
    assert.equal(retry.status, 409);
    assert.equal(retry.body.code, "BOOKING_SETUP_FAILED");
    const rebook = await place(request("09:00", { service_date: futureWeekday(10) }), "k-rebook");
    assert.equal(rebook.status, 201, "the released slot can be booked again");
  });

  await t.test("compensation that cannot be confirmed is never reported as cancelled", async () => {
    const fake = setup();
    fake.mode.create = "timeout";
    fake.mode.cancel = "fail";
    const res = await place(request("11:00", { service_date: futureWeekday(10) }), "k-stuck");
    const orderId = res.body.order_id;
    for (let i = 0; i < 6; i += 1) { await tick(); await recoverOnce(); }
    assert.equal(saga(orderId).state, STATES.RECOVERY_PENDING, "visible for manual recovery");
    assert.ok(holds(orderId) > 0, "slots kept: the create might still exist");
    assert.equal(getDb().prepare("SELECT status FROM orders WHERE id = ?").get(orderId).status, "awaiting");
    assert.equal(fake.calls.cancel.length, 2);
  });

  await t.test("finalize fails after the intent exists: void it by command, then cancel locally", async () => {
    const fake = setup();
    getDb().exec(`CREATE TRIGGER fail_finalize BEFORE INSERT ON events WHEN NEW.type = 'booking.status_changed'
      BEGIN SELECT RAISE(ABORT, 'simulated finalize failure'); END`);
    try {
      const res = await place(request("13:00", { service_date: futureWeekday(10) }), "k-finalize");
      const orderId = res.body.order_id;
      assert.equal(res.status, 503);
      assert.equal(saga(orderId).state, STATES.COMPENSATION_PENDING);
      assert.equal(saga(orderId).cancel_reason, "booking_finalization_failed");
      await tick();
      await recoverOnce();
      assert.equal(saga(orderId).state, STATES.CANCELLED);
      assert.equal(fake.intentsFor(orderId)[0].intent.status, "failed", "the created intent was voided");
      assert.equal(holds(orderId), 0);
    } finally {
      getDb().exec("DROP TRIGGER fail_finalize");
    }
  });

  await t.test("restart: a new process picks up a pending saga left by a dead one", async () => {
    const fake = setup();
    fake.mode.create = "timeout";
    const res = await place(request("15:00", { service_date: futureWeekday(10) }), "k-restart");
    const orderId = res.body.order_id;
    getDb().prepare("UPDATE booking_sagas SET locked_by = 'dead-process', locked_until = ? WHERE order_id = ?")
      .run(new Date(Date.now() + 100).toISOString(), orderId);
    resetBookingSaga();
    configureBookingSaga({ payments: fake.adapter, baseBackoffMs: 1, maxBackoffMs: 1 }); // "new process"
    fake.mode.create = "ok";
    assert.equal(await recoverOnce(), 0, "a live lease from the dead process is respected");
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(await recoverOnce(), 1);
    assert.equal(saga(orderId).state, STATES.COMPLETED);
    assert.equal(fake.intentsFor(orderId).length, 1);
  });

  resetBookingSaga();
});
