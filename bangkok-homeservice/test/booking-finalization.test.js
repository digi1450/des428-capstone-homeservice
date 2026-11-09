// Area C, step 5C: Booking financial finalization (durable completion/cancellation work, local
// transition guard, recovery). Drives A's real public routes and caller seam
// (configureBookingFinancialAccess) with C's real callbacks. Payments is a scriptable fake that
// returns contract-v1-shaped results / A's client error types. In-memory SQLite.
import { freshBoot, getDb } from "../test-helpers/boot.js";
import test from "node:test";
import assert from "node:assert/strict";
import { call } from "../test-helpers/call.js";
import { signToken } from "../lib/http/auth.js";
import * as completeRoute from "../app/api/bookings/[id]/complete/route.js";
import * as cancelRoute from "../app/api/bookings/[id]/cancel/route.js";
import * as booking from "../lib/modules/booking/service.js";
import { configureBookingFinancialAccess, resetBookingFinancialAccess, financialStatus } from "../lib/modules/booking/financial-access.js";
import { createBookingFinalization, resetBookingFinalization, recoverFinalizationOnce, deliverFinancialWork, WORK } from "../lib/modules/booking/finalization.js";
import { FinancialOutcomeUnknownError, FinancialReconciliationError } from "../lib/modules/payments/financial-client.js";
import { AppError } from "../lib/errors.js";

freshBoot();
const db = () => getDb();
const customer = () => db().prepare("SELECT id FROM customers ORDER BY id LIMIT 1").get().id;
const provider = () => db().prepare("SELECT id FROM providers ORDER BY id LIMIT 1").get().id;
let dayCounter = 0;
function order({ status = "started", method = "cod", paymentStatus = "pending", saga = method === "gateway" } = {}) {
  const day = `2027-01-${String(1 + (dayCounter++ % 28)).padStart(2, "0")}`;
  const time = `${String(8 + Math.floor(dayCounter / 28) % 10).padStart(2, "0")}:00`;
  const id = db().prepare(`INSERT INTO orders (customer_id,provider_id,service_date,starting_time,ending_time,duration_min,subtotal_cents,tax_cents,total_cents,commission_pct,payment_method,payment_status,otp,status)
    VALUES (?,?,?,?,?,30,10000,700,10700,10,?,?,123456,?)`).run(customer(), provider(), day, time, time.replace(":00", ":30"), method, paymentStatus, status).lastInsertRowid;
  db().prepare("INSERT INTO slot_holds (provider_id, service_date, slot_time, order_id) VALUES (?,?,?,?)").run(provider(), day, time, id);
  if (saga) {
    db().prepare(`INSERT INTO booking_sagas (saga_id,order_id,customer_id,request_key,request_digest,state,create_command_id,cancel_command_id,snapshot_json,intent_json)
      VALUES (?,?,?,?,'d','COMPLETED',?,?,'{}','{}')`).run(`saga-${id}`, id, customer(), `key-${id}`, `create:saga-${id}`, `cancel:saga-${id}`);
  }
  return id;
}

// Scriptable Payments (A's client interface). Each call shifts one scripted behaviour (default "ready").
function fakeFinancial() {
  const calls = [];
  const script = [];
  let nextId = 100;
  const respond = (kind, work) => {
    const mode = script.shift() ?? "ready";
    calls.push({ kind, commandId: work.commandId, request: work.request, mode });
    const base = { command_id: work.commandId, kind, request: work.request };
    const ready = kind === "completion"
      ? { ...base, state: "ready", accounting: { transaction_id: nextId++, kind: work.request.payment_method === "gateway" ? "payout_credit" : "commission_owed",
        amount_cents: work.request.payment_method === "gateway" ? work.request.amount_cents - work.request.commission_cents : work.request.commission_cents } }
      : { ...base, state: "ready", settlement_fenced: true, ...(typeof mode === "object" ? mode : { outcome: "no_payment" }) };
    if (mode === "ready" || typeof mode === "object") return ready;
    if (mode === "awaiting") return { ...base, state: "pending", reason: "awaiting_settlement" };
    if (mode === "attention") return { ...base, state: "attention", reason: kind === "completion" ? "settlement_contradiction" : "completion_accounted" };
    if (mode === "unknown") throw new FinancialOutcomeUnknownError("transport_or_invalid_body");
    if (mode === "lost") { calls.at(-1).effect = ready; throw new FinancialOutcomeUnknownError("transport_or_invalid_body"); }
    if (mode === "blocked") throw new FinancialReconciliationError("FINANCIAL_OPERATION_BLOCKED");
    if (mode === "auth") throw new AppError(401, "financial credentials rejected");
    throw new Error(`unknown mode ${mode}`);
  };
  return {
    calls, script,
    client: { complete: async (work) => respond("completion", work), cancel: async (work) => respond("cancellation", work) },
  };
}

function install() {
  resetBookingFinancialAccess();
  const fake = fakeFinancial();
  const callbacks = createBookingFinalization({ financial: fake.client, credentials: async () => ({ token: "service-fixture" }), baseBackoffMs: 1, maxBackoffMs: 1, escalateAfter: 3 });
  configureBookingFinancialAccess({ bookingFinalization: callbacks });
  return fake;
}
const work = (orderId, kind) => db().prepare("SELECT * FROM booking_financial_work WHERE order_id = ? AND kind = ?").get(orderId, kind);
const row = (orderId) => db().prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
const holds = (orderId) => db().prepare("SELECT count(*) AS n FROM slot_holds WHERE order_id = ?").get(orderId).n;
const events = (orderId, type) => db().prepare("SELECT payload_json FROM events WHERE aggregate_id = ? AND type = ?").all(orderId, type).map((e) => JSON.parse(e.payload_json));
const ledger = (orderId) => db().prepare("SELECT count(*) AS n FROM transactions WHERE order_id = ?").get(orderId).n;
const attention = (orderId) => db().prepare("SELECT reason FROM consistency_attention WHERE consumer_name = 'booking-finalization' AND aggregate_id = ? ORDER BY id").all(String(orderId)).map((r) => r.reason);
const tick = () => new Promise((r) => setTimeout(r, 5));
const complete = (orderId, otp = 123456) => call(completeRoute.POST, { token: signToken({ sub: provider(), role: "provider" }), params: { id: String(orderId) }, body: { otp } });
const cancel = (orderId) => call(cancelRoute.POST, { token: signToken({ sub: customer(), role: "customer" }), params: { id: String(orderId) }, body: {} });

test("Booking financial finalization", async (t) => {
  t.after(() => { resetBookingFinancialAccess(); resetBookingFinalization(); });

  await t.test("COD completion: one transaction completes + saves work; accounting ready; no SQLite money", async () => {
    const fake = install();
    const id = order();
    const walletBefore = db().prepare("SELECT * FROM provider_wallets WHERE provider_id = ?").get(provider());
    const res = await complete(id);
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.status, res.body.accounting_status, res.body.commission_cents, res.body.provider_earnings_cents], ["completed", "ready", 1070, 9630]);
    const w = work(id, "completion");
    assert.equal(w.command_id, `complete:${w.operation_id}`);
    assert.deepEqual(JSON.parse(w.request_json), { operation_id: w.operation_id, order_id: id, customer_id: customer(), provider_id: provider(),
      amount_cents: 10700, currency: "THB", payment_method: "cod", commission_cents: 1070 });
    assert.equal(events(id, "booking.completed").length, 1);
    assert.equal(ledger(id), 0, "no local ledger write in financial mode");
    assert.deepEqual(db().prepare("SELECT * FROM provider_wallets WHERE provider_id = ?").get(provider()), walletBefore, "no local wallet write");
    const replay = await complete(id);
    assert.equal(replay.status, 200);
    assert.equal(fake.calls.length, 1, "terminal work is not re-sent");
    assert.equal((await complete(id, 111111)).status, 409, "replay still checks the OTP");
  });

  await t.test("Payments unavailable: completion still commits (accounting pending), recovery uses the SAME key", async () => {
    const fake = install();
    fake.script.push("unknown", "lost");
    const id = order();
    const res = await complete(id);
    assert.deepEqual([res.status, res.body.status, res.body.accounting_status], [200, "completed", "pending"]);
    await tick(); await recoverFinalizationOnce();
    assert.equal(work(id, "completion").state, WORK.PENDING, "lost reply is still unknown here");
    await tick(); await recoverFinalizationOnce();
    assert.equal(work(id, "completion").state, WORK.READY);
    assert.equal(new Set(fake.calls.map((c) => c.commandId)).size, 1);
    assert.equal(fake.calls.length, 3);
    assert.deepEqual(await financialStatus(id, { role: "provider", sub: provider() }), { accounting_status: "ready" });
  });

  await t.test("gateway completion waits (awaiting_settlement) and becomes ready on a later retry", async () => {
    const fake = install();
    fake.script.push("awaiting", "awaiting");
    const id = order({ method: "gateway", paymentStatus: "paid" });
    const res = await complete(id);
    assert.equal(res.body.accounting_status, "pending");
    const request = JSON.parse(work(id, "completion").request_json);
    assert.deepEqual(request.provisioning, { create_command_id: `create:saga-${id}`, saga_id: `saga-${id}` });
    await tick(); await recoverFinalizationOnce();
    await tick(); await recoverFinalizationOnce();
    assert.equal(work(id, "completion").state, WORK.READY);
    assert.deepEqual(attention(id), [], "waiting for settlement is not an incident");
  });

  await t.test("legacy gateway booking (no saga) cannot complete in financial mode: nothing changes", async () => {
    install();
    const id = order({ method: "gateway", saga: false });
    const res = await complete(id);
    assert.equal(res.status, 409);
    assert.equal(row(id).status, "started", "the completion rolled back");
    assert.equal(work(id, "completion"), undefined);
    assert.equal(events(id, "booking.completed").length, 0);
  });

  await t.test("work insert failure rolls back the local completion and its events", async () => {
    install();
    const id = order();
    db().exec("CREATE TRIGGER fail_work BEFORE INSERT ON booking_financial_work BEGIN SELECT RAISE(ABORT, 'simulated work failure'); END");
    try {
      const res = await complete(id);
      assert.equal(res.status, 500);
      assert.equal(row(id).status, "started");
      assert.equal(events(id, "booking.completed").length, 0);
    } finally { db().exec("DROP TRIGGER fail_work"); }
  });

  await t.test("cancellation pending keeps order + holds and blocks confirm/start/reschedule; ready finalizes once", async () => {
    const fake = install();
    fake.script.push("unknown", "unknown"); // the repeated customer request re-sends the same work
    const id = order({ status: "awaiting", method: "gateway" });
    let res = await cancel(id);
    assert.deepEqual([res.status, res.body.order.status, res.body.cancellation_status], [202, "awaiting", "pending"]);
    assert.equal(holds(id), 1, "slots are kept until Payments confirms");
    assert.throws(() => booking.confirmBooking(id, provider()), /pending reconciliation/);
    assert.equal(row(id).status, "awaiting");
    res = await cancel(id);
    assert.equal(res.status, 202, "same logical cancellation, no second work row");
    assert.equal(db().prepare("SELECT count(*) AS n FROM booking_financial_work WHERE order_id = ?").get(id).n, 1);
    fake.script.push({ outcome: "voided", voided_intent_id: 55 });
    await tick(); await recoverFinalizationOnce();
    assert.deepEqual([row(id).status, row(id).payment_status, holds(id)], ["cancelled", "pending", 0]);
    assert.equal(events(id, "booking.status_changed").filter((e) => e.to === "cancelled").length, 1);
    res = await cancel(id);
    assert.deepEqual([res.status, res.body.refunded, res.body.cancellation_status], [200, false, "ready"]);
    assert.equal(new Set(fake.calls.map((c) => c.commandId)).size, 1);
  });

  await t.test("paid gateway cancellation: refunded only when Payments says refunded", async () => {
    const fake = install();
    fake.script.push({ outcome: "refunded", refund_transaction_id: 77 });
    const id = order({ status: "confirmed", method: "gateway", paymentStatus: "paid" });
    const res = await cancel(id);
    assert.deepEqual([res.status, res.body.refunded, res.body.order.payment_status, res.body.order.status], [200, true, "refunded", "cancelled"]);
    assert.equal(ledger(id), 0, "the refund lives in Payments, not SQLite");
  });

  await t.test("paid booking but Payments reports no refund: attention, nothing released", async () => {
    const fake = install();
    fake.script.push({ outcome: "no_payment" });
    const id = order({ status: "confirmed", method: "gateway", paymentStatus: "paid" });
    const res = await cancel(id);
    assert.deepEqual([res.status, res.body.cancellation_status], [409, "attention"]);
    assert.deepEqual([row(id).status, holds(id)], ["confirmed", 1]);
    assert.equal(attention(id).length, 1);
  });

  await t.test("attention and coded conflicts: recorded once, never retried, holds kept, transitions blocked", async () => {
    for (const mode of ["attention", "blocked"]) {
      const fake = install();
      fake.script.push(mode);
      const id = order({ status: "confirmed" });
      const res = await cancel(id);
      assert.deepEqual([res.status, res.body.cancellation_status], [409, "attention"], mode);
      assert.equal(work(id, "cancellation").reason, mode === "blocked" ? "FINANCIAL_OPERATION_BLOCKED" : "completion_accounted");
      assert.equal(attention(id).length, 1);
      await tick(); await recoverFinalizationOnce();
      assert.equal(fake.calls.filter((c) => c.request.order_id === id).length, 1, `${mode}: not retried`);
      assert.deepEqual([row(id).status, holds(id)], ["confirmed", 1]);
      assert.throws(() => booking.startBooking(id, provider()), /pending reconciliation/);
    }
  });

  await t.test("repeated unknowns escalate once; rejected credentials are recorded immediately", async () => {
    let fake = install();
    fake.script.push("unknown", "unknown", "unknown", "unknown");
    let id = order({ status: "awaiting" });
    await cancel(id);
    for (let i = 0; i < 3; i += 1) { await tick(); await recoverFinalizationOnce(); }
    assert.equal(work(id, "cancellation").state, WORK.PENDING);
    assert.deepEqual(attention(id), ["financial outcome unconfirmed"]);
    fake = install();
    fake.script.push("auth");
    id = order({ status: "awaiting" });
    await cancel(id);
    assert.equal(work(id, "cancellation").state, WORK.PENDING);
    assert.deepEqual(attention(id), ["financial credentials rejected"]);
  });

  await t.test("stale worker: a late result after lease replacement is discarded", async () => {
    const fake = install();
    fake.script.push("unknown");
    const id = order({ status: "awaiting" });
    await cancel(id);
    const op = work(id, "cancellation").operation_id;
    const gates = [];
    fake.client.cancel = (w) => new Promise((resolve) => gates.push(() => resolve({ command_id: w.commandId, kind: "cancellation", request: w.request, state: "ready", settlement_fenced: true, outcome: "no_payment" })));
    await tick();
    const a = deliverFinancialWork(op);
    await tick();
    db().prepare("UPDATE booking_financial_work SET locked_until = '2000-01-01T00:00:00.000Z' WHERE operation_id = ?").run(op);
    const b = deliverFinancialWork(op);
    await tick();
    const tokenB = work(id, "cancellation").locked_by;
    gates[0](); await a;
    assert.deepEqual([work(id, "cancellation").state, work(id, "cancellation").locked_by, row(id).status], [WORK.PENDING, tokenB, "awaiting"]);
    gates[1](); await b;
    assert.deepEqual([work(id, "cancellation").state, row(id).status], [WORK.READY, "cancelled"]);
    assert.equal(events(id, "booking.status_changed").filter((e) => e.to === "cancelled").length, 1, "finalized exactly once");
  });

  await t.test("a pending cancellation blocks completion; a completed booking cannot be cancelled", async () => {
    const fake = install();
    fake.script.push("unknown");
    const id = order({ status: "confirmed" });
    await cancel(id);
    db().prepare("UPDATE orders SET status = 'started' WHERE id = ?").run(id); // even if a transition slipped through
    assert.equal((await complete(id)).status, 409);
    const done = order();
    await complete(done);
    assert.equal((await cancel(done)).status, 409);
  });
});
