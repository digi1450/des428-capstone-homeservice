// Must be the first import: gives the monolith an isolated in-memory SQLite database.
import { freshBoot, getDb } from "../../bangkok-homeservice/test-helpers/boot.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { call } from "../../bangkok-homeservice/test-helpers/call.js";
import { signToken } from "../../bangkok-homeservice/lib/http/auth.js";
import * as completeRoute from "../../bangkok-homeservice/app/api/bookings/[id]/complete/route.js";
import * as cancelRoute from "../../bangkok-homeservice/app/api/bookings/[id]/cancel/route.js";
import { configureBookingFinancialAccess, resetBookingFinancialAccess } from "../../bangkok-homeservice/lib/modules/booking/financial-access.js";
import { createBookingFinalization, resetBookingFinalization, recoverFinalizationOnce } from "../../bangkok-homeservice/lib/modules/booking/finalization.js";
import { createFinancialClient } from "../../bangkok-homeservice/lib/modules/payments/financial-client.js";
import { createDatabase } from "../../services/payments-wallet/src/database.js";
import { migrate } from "../../services/payments-wallet/src/migrations.js";
import { createPaymentsRuntime } from "../../services/payments-wallet/src/runtime.js";
import { createFinancialOperations } from "../../services/payments-wallet/src/financial/index.js";
import { HttpError } from "../../services/payments-wallet/src/errors.js";

// Area C, step 5C end to end: A's public Booking routes -> C finalization (SQLite work/guard) ->
// A's real financial client over HTTP -> A's Payments router -> C financial operations -> PG.
// Auth is an explicit fixture verifier (no Keycloak). DISPOSABLE PostgreSQL only.
const enabled = !!process.env.TEST_PAYMENTS_DATABASE_URL;

test("Booking finalization against real Payments financial operations", { skip: !enabled }, async (t) => {
  freshBoot();
  const pg = createDatabase(process.env.TEST_PAYMENTS_DATABASE_URL);
  await migrate(pg);
  const callerId = `booking-e2e:${randomUUID()}`;
  const runtime = createPaymentsRuntime({ database: pg, createFinancialOperations,
    authenticate: async () => { throw new HttpError(403, "no user flow"); },
    authenticateService: async (req) => { if (req.get("authorization") !== "Bearer booking-service") throw new HttpError(401, "bad"); return { service: "booking", callerId }; },
  });
  let server = null;
  let port = 0;
  const listen = async () => { server = runtime.app.listen(port, "127.0.0.1"); await new Promise((r) => server.once("listening", r)); port = server.address().port; };
  const stop = async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); server = null; };
  await listen();
  const client = createFinancialClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 1000 });
  resetBookingFinancialAccess();
  configureBookingFinancialAccess({ bookingFinalization: createBookingFinalization({ financial: client,
    credentials: async () => ({ token: "booking-service" }), baseBackoffMs: 1, maxBackoffMs: 1 }) });
  t.after(async () => { resetBookingFinancialAccess(); resetBookingFinalization(); if (server) await stop(); await pg.close(); });

  const db = getDb();
  const customer = db.prepare("SELECT id FROM customers ORDER BY id LIMIT 1").get().id;
  const provider = db.prepare("SELECT id FROM providers ORDER BY id LIMIT 1").get().id;
  let n = 0;
  async function booking({ status, method, provision = true }) {
    n += 1;
    const day = `2027-03-${String(n).padStart(2, "0")}`;
    const id = db.prepare(`INSERT INTO orders (id,customer_id,provider_id,service_date,starting_time,ending_time,duration_min,subtotal_cents,tax_cents,total_cents,commission_pct,payment_method,otp,status)
      VALUES (?,?,?,?,'10:00','10:30',30,10000,700,10700,10,?,123456,?)`).run(490000 + n, customer, provider, day, method, status).lastInsertRowid;
    db.prepare("INSERT INTO slot_holds (provider_id, service_date, slot_time, order_id) VALUES (?,?,'10:00',?)").run(provider, day, id);
    if (method !== "gateway") return { id };
    // The provisioning saga already completed: real C participant create + activate in Payments,
    // and the matching saga row in SQLite (same create command / saga ids).
    const create = `create:${randomUUID()}`, saga = `saga:${randomUUID()}`;
    let intent = null;
    if (provision) {
      const { result } = await runtime.participant.create({ callerId, commandId: create,
        request: { order_id: id, customer_id: customer, provider_id: provider, amount_cents: 10700, currency: "THB", saga_id: saga } });
      intent = result.payment_intent;
      await runtime.participant.activate({ callerId, commandId: `activate:${saga}`, request: { create_command_id: create, saga_id: saga } });
    }
    db.prepare(`INSERT INTO booking_sagas (saga_id,order_id,customer_id,request_key,request_digest,state,create_command_id,cancel_command_id,snapshot_json,intent_json)
      VALUES (?,?,?,?,'d',?,?,?,'{}',?)`).run(saga, id, customer, `k-${id}`, provision ? "COMPLETED" : "INTENT_CREATE_PENDING", create, `cancel:${saga}`, JSON.stringify(intent));
    return { id, intent, create, saga };
  }
  const settle = (intent) => runtime.business.settleWebhook({ gateway_event_id: `evt:${randomUUID()}`, type: "payment_intent.succeeded", gateway_ref: intent.gateway_ref });
  const complete = (id) => call(completeRoute.POST, { token: signToken({ sub: provider, role: "provider" }), params: { id: String(id) }, body: { otp: 123456 } });
  const cancel = (id) => call(cancelRoute.POST, { token: signToken({ sub: customer, role: "customer" }), params: { id: String(id) }, body: {} });
  const ledger = async (id) => (await pg.query("SELECT kind FROM transactions WHERE order_id=$1 ORDER BY id", [id])).rows.map((r) => r.kind);
  const order = (id) => db.prepare("SELECT status, payment_status FROM orders WHERE id = ?").get(id);
  const holds = (id) => db.prepare("SELECT count(*) AS n FROM slot_holds WHERE order_id = ?").get(id).n;
  const tick = () => new Promise((r) => setTimeout(r, 5));

  await t.test("COD completion: ready, commission recorded once in Payments", async () => {
    const { id } = await booking({ status: "started", method: "cod" });
    const res = await complete(id);
    assert.deepEqual([res.status, res.body.status, res.body.accounting_status], [200, "completed", "ready"]);
    assert.deepEqual(await ledger(id), ["commission_owed"]);
    assert.equal((await complete(id)).status, 200);
    assert.deepEqual(await ledger(id), ["commission_owed"], "replay adds nothing");
  });

  await t.test("gateway completion before payment: pending; after settlement recovery pays out once", async () => {
    const { id, intent } = await booking({ status: "started", method: "gateway" });
    const res = await complete(id);
    assert.deepEqual([res.status, res.body.accounting_status], [200, "pending"]);
    assert.deepEqual(await ledger(id), []);
    await settle(intent);
    await tick(); await recoverFinalizationOnce();
    assert.deepEqual(await ledger(id), ["charge", "payout_credit"]);
    assert.equal((await call(completeRoute.POST, { token: signToken({ sub: provider, role: "provider" }), params: { id: String(id) }, body: { otp: 123456 } })).body.accounting_status, "ready");
  });

  await t.test("gateway cancellation (unpaid): void + fence in Payments, then local cancel + hold release", async () => {
    const { id, intent } = await booking({ status: "confirmed", method: "gateway" });
    const res = await cancel(id);
    assert.deepEqual([res.status, res.body.cancellation_status, res.body.refunded, res.body.order.status], [200, "ready", false, "cancelled"]);
    assert.equal(holds(id), 0);
    await assert.rejects(settle(intent), (e) => e.statusCode === 409, "late payment cannot settle after the fence");
    assert.deepEqual(await ledger(id), []);
  });

  await t.test("cancel before create: durable pending while down, recovery fences late create and activation", async () => {
    const { id, create, saga } = await booking({ status: "awaiting", method: "gateway", provision: false });
    await stop();
    const res = await cancel(id);
    assert.deepEqual([res.status, res.body.cancellation_status, holds(id)], [202, "pending", 1]);
    const key = db.prepare("SELECT command_id FROM booking_financial_work WHERE order_id=?").get(id).command_id;
    await listen(); await tick(); await recoverFinalizationOnce();
    assert.deepEqual([order(id).status, holds(id)], ["cancelled", 0]);
    assert.equal(db.prepare("SELECT state FROM booking_sagas WHERE order_id=?").get(id).state, "CANCELLED");
    assert.deepEqual((await pg.query("SELECT command_id,state FROM financial_commands WHERE order_id=$1", [id])).rows,
      [{ command_id: key, state: "ready" }]);
    await assert.rejects(runtime.participant.create({ callerId, commandId: create,
      request: { order_id: id, customer_id: customer, provider_id: provider, amount_cents: 10700, currency: "THB", saga_id: saga } }),
      e => e.statusCode === 409 && e.code === "PAYMENT_SETUP_CANCELLED");
    await assert.rejects(runtime.participant.activate({ callerId, commandId: `activate:${saga}`,
      request: { create_command_id: create, saga_id: saga } }), e => e.statusCode === 409 && e.code === "PAYMENT_SETUP_CANCELLED");
    assert.deepEqual(await ledger(id), []);
    assert.equal((await cancel(id)).body.cancellation_status, "ready");
  });

  await t.test("paid gateway cancellation: one refund in Payments, booking refunded", async () => {
    const { id, intent } = await booking({ status: "confirmed", method: "gateway" });
    await settle(intent);
    db.prepare("UPDATE orders SET payment_status = 'paid' WHERE id = ?").run(id); // Booking's payment.succeeded consumer
    const res = await cancel(id);
    assert.deepEqual([res.status, res.body.refunded, order(id).payment_status], [200, true, "refunded"]);
    assert.deepEqual(await ledger(id), ["charge", "refund"]);
  });

  await t.test("Payments down: cancellation stays pending with holds; after restart recovery converges once", async () => {
    const { id } = await booking({ status: "awaiting", method: "cod" });
    await stop();
    const res = await cancel(id);
    assert.deepEqual([res.status, res.body.cancellation_status, order(id).status, holds(id)], [202, "pending", "awaiting", 1]);
    await listen(); // same port, new process-equivalent listener
    await tick(); await recoverFinalizationOnce();
    assert.deepEqual([order(id).status, holds(id)], ["cancelled", 0]);
    const rows = (await pg.query("SELECT state FROM financial_commands WHERE order_id=$1", [id])).rows;
    assert.deepEqual(rows, [{ state: "ready" }], "exactly one Payments command");
  });
});
