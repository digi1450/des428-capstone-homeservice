
// Area C: the saga through A's REAL Payments HTTP client and Booking adapter,
// against a local HTTP fixture that follows the draft internal contract.
// This fixture simulates lost responses and temporary payment failures.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { freshBoot, getDb } from "../test-helpers/boot.js";
import { call } from "../test-helpers/call.js";
import {
  loginSeededCustomer,
  loginSeededProvider,
  futureWeekday
} from "../test-helpers/auth.js";

import * as bookings from "../app/api/bookings/route.js";
import { createPaymentsClient } from "../lib/modules/payments/client.js";
import { createBookingPaymentsAdapter } from "../lib/modules/booking/payment-adapter.js";

import {
  configureBookingSaga,
  resetBookingSaga,
  recoverOnce,
  STATES
} from "../lib/modules/booking/saga.js";

freshBoot();

test("saga over the real Payments HTTP client", async (t) => {
  const operations = new Map();

  let stall = false;
  let failOnce = false;
  let nextId = 1;

  const server = http.createServer(async (req, res) => {
    let raw = "";

    for await (const chunk of req) {
      raw += chunk;
    }

    const send = (status, body) => {
      res.writeHead(status, {
        "content-type": "application/json"
      });
      res.end(JSON.stringify(body));
    };

    if (
      req.method === "POST" &&
      req.url === "/internal/payment-intents"
    ) {
      const body = JSON.parse(raw);
      const key = req.headers["idempotency-key"];

      if (!operations.has(key)) {
        operations.set(key, {
          id: nextId++,
          order_id: body.order_id,
          amount_cents: body.amount_cents,
          gateway_ref: `SIM-PI-http-${key}`,
          status: "requires_payment"
        });
      }

      // Simulate a temporary payment failure.
      if (failOnce) {
        failOnce = false;
        return send(500, {
          error: "temporary payment failure"
        });
      }

      // Simulate a committed payment with a lost response.
      if (stall) {
        return;
      }

      return send(201, {
        create_command_id: key,
        saga_id: body.saga_id,
        outcome: "created",
        payment_intent: operations.get(key)
      });
    }

    send(404, {
      error: "not found",
      requestId: "fixture"
    });
  });

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const paymentsClient = createPaymentsClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    timeoutMs: 300
  });

  configureBookingSaga({
    payments: createBookingPaymentsAdapter({ paymentsClient }),
    credentials: async () => ({ token: "fixture-token" }),
    baseBackoffMs: 1,
    maxBackoffMs: 1
  });

  try {
    const customer = await loginSeededCustomer("nong@example.com");
    const provider = await loginSeededProvider("sparkle@example.com");

    const addressId = getDb()
      .prepare(
        "SELECT id FROM addresses WHERE customer_id = ? LIMIT 1"
      )
      .get(customer.id).id;

    const body = {
      provider_id: provider.id,
      address_id: addressId,
      service_date: futureWeekday(12),
      starting_time: "10:00",
      items: [{ service_id: 2, quantity: 1 }],
      payment_method: "gateway"
    };

    // Test 1: Payment succeeds, but the response is lost.
    await t.test(
      "a stalled reply times out into 503 pending; retry completes with the same intent",
      async () => {
        stall = true;

        const first = await call(bookings.POST, {
          token: customer.token,
          body,
          headers: {
            "idempotency-key": "http-1"
          }
        });

        assert.equal(first.status, 503);

        const sagaRow = getDb()
          .prepare(
            "SELECT * FROM booking_sagas WHERE order_id = ?"
          )
          .get(first.body.order_id);

        assert.equal(sagaRow.state, STATES.CREATE_PENDING);

        assert.equal(
          operations.size,
          1,
          "Payments committed the intent before the reply was lost"
        );

        stall = false;

        await new Promise((resolve) => setTimeout(resolve, 5));

        await recoverOnce();

        const second = await call(bookings.POST, {
          token: customer.token,
          body,
          headers: {
            "idempotency-key": "http-1"
          }
        });

        assert.equal(second.status, 201);

        assert.equal(
          second.body.payment_intent.id,
          operations.get(sagaRow.create_command_id).id
        );

        assert.equal(
          operations.size,
          1,
          "retry did not create a duplicate payment intent"
        );

        assert.equal(
          second.body.order.id,
          first.body.order_id,
          "retry returns the original booking"
        );
      }
    );

    // Test 2: Payment temporarily fails, then succeeds on retry.
    await t.test(
      "temporary payment failure recovers on retry with the same intent",
      async () => {
        const retryBody = {
          ...body,
          service_date: futureWeekday(15)
        };

        failOnce = true;

        const first = await call(bookings.POST, {
          token: customer.token,
          body: retryBody,
          headers: {
            "idempotency-key": "http-2"
          }
        });

        assert.equal(first.status, 503);

        const sagaRow = getDb()
          .prepare(
            "SELECT * FROM booking_sagas WHERE order_id = ?"
          )
          .get(first.body.order_id);

        assert.equal(sagaRow.state, STATES.CREATE_PENDING);

        const bookingCount = getDb()
          .prepare(
            "SELECT COUNT(*) AS n FROM orders WHERE id = ?"
          )
          .get(first.body.order_id).n;

        assert.equal(
          bookingCount,
          1,
          "only one booking was created"
        );

        assert.equal(
          operations.size,
          2,
          "one payment intent per command"
        );

        await new Promise((resolve) => setTimeout(resolve, 5));

        await recoverOnce();

        const second = await call(bookings.POST, {
          token: customer.token,
          body: retryBody,
          headers: {
            "idempotency-key": "http-2"
          }
        });

        assert.equal(second.status, 201);

        assert.equal(
          second.body.order.id,
          first.body.order_id,
          "retry returns the original booking"
        );

        assert.equal(
          second.body.payment_intent.id,
          operations.get(sagaRow.create_command_id).id,
          "retry uses the same payment intent"
        );

        assert.equal(
          operations.size,
          2,
          "retry did not create a duplicate payment intent"
        );

        const finalBookingCount = getDb()
          .prepare(
            "SELECT COUNT(*) AS n FROM orders WHERE id = ?"
          )
          .get(first.body.order_id).n;

        assert.equal(
          finalBookingCount,
          1,
          "booking was not duplicated after recovery"
        );
      }
    );
  } finally {
    resetBookingSaga();

    server.closeAllConnections();

    await new Promise((resolve) => {
      server.close(resolve);
    });
  }
});
