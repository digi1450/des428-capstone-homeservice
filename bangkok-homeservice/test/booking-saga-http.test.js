// Area C: the saga through A's REAL Payments HTTP client and Booking adapter, against a local HTTP
// fixture that follows the draft internal contract (contracts/payment-intents.openapi.json).
// Proves a real network timeout (stalled reply) becomes "pending" — never compensation — and that
// the same create command later yields the one intent. This is a fixture, not the Payments service:
// its internal endpoints are not mounted yet.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { freshBoot, getDb } from "../test-helpers/boot.js";
import { call } from "../test-helpers/call.js";
import { loginSeededCustomer, loginSeededProvider, futureWeekday } from "../test-helpers/auth.js";
import * as bookings from "../app/api/bookings/route.js";
import { createPaymentsClient } from "../lib/modules/payments/client.js";
import { createBookingPaymentsAdapter } from "../lib/modules/booking/payment-adapter.js";
import { configureBookingSaga, resetBookingSaga, recoverOnce, STATES } from "../lib/modules/booking/saga.js";

freshBoot();

test("saga over the real Payments HTTP client", async (t) => {
  const operations = new Map();
  let stall = false;
  let nextId = 1;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "POST" && req.url === "/internal/payment-intents") {
      const body = JSON.parse(raw);
      const key = req.headers["idempotency-key"];
      if (!operations.has(key)) {
        operations.set(key, { id: nextId++, order_id: body.order_id, amount_cents: body.amount_cents, gateway_ref: `SIM-PI-http-${key}`, status: "requires_payment" });
      }
      if (stall) return; // committed, but the reply never arrives: the client times out
      return send(201, { create_command_id: key, saga_id: body.saga_id, outcome: "created", payment_intent: operations.get(key) });
    }
    send(404, { error: "not found", requestId: "fixture" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const paymentsClient = createPaymentsClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 300 });
  configureBookingSaga({ payments: createBookingPaymentsAdapter({ paymentsClient }), credentials: async () => ({ token: "fixture-token" }),
    baseBackoffMs: 1, maxBackoffMs: 1 });
  try {
    const customer = await loginSeededCustomer("nong@example.com");
    const provider = await loginSeededProvider("sparkle@example.com");
    const addressId = getDb().prepare("SELECT id FROM addresses WHERE customer_id = ? LIMIT 1").get(customer.id).id;
    const body = { provider_id: provider.id, address_id: addressId, service_date: futureWeekday(12), starting_time: "10:00",
      items: [{ service_id: 2, quantity: 1 }], payment_method: "gateway" };

    await t.test("a stalled reply times out into 503 pending; the retry completes with the same intent", async () => {
      stall = true;
      const first = await call(bookings.POST, { token: customer.token, body, headers: { "idempotency-key": "http-1" } });
      assert.equal(first.status, 503);
      const sagaRow = getDb().prepare("SELECT * FROM booking_sagas WHERE order_id = ?").get(first.body.order_id);
      assert.equal(sagaRow.state, STATES.CREATE_PENDING);
      assert.equal(operations.size, 1, "Payments committed the intent before the reply was lost");
      stall = false;
      await new Promise((resolve) => setTimeout(resolve, 5));
      await recoverOnce();
      const second = await call(bookings.POST, { token: customer.token, body, headers: { "idempotency-key": "http-1" } });
      assert.equal(second.status, 201);
      assert.equal(second.body.payment_intent.id, operations.get(sagaRow.create_command_id).id);
      assert.equal(operations.size, 1, "still exactly one intent");
    });
  } finally {
    resetBookingSaga();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
