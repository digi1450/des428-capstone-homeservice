// Area C demo: prints the saga's state BEFORE and AFTER compensation for one gateway booking whose
// payment setup never succeeds. In-memory SQLite + a contract-faithful fake Payments behind A's
// Booking adapter (the Payments internal endpoints are not mounted yet).
//   node tests/integration/c-saga-demo.mjs
import { freshBoot, getDb } from "../../bangkok-homeservice/test-helpers/boot.js";
import { call } from "../../bangkok-homeservice/test-helpers/call.js";
import { loginSeededCustomer, loginSeededProvider, futureWeekday } from "../../bangkok-homeservice/test-helpers/auth.js";
import * as bookings from "../../bangkok-homeservice/app/api/bookings/route.js";
import { createBookingPaymentsAdapter } from "../../bangkok-homeservice/lib/modules/booking/payment-adapter.js";
import { PaymentOutcomeUnknownError } from "../../bangkok-homeservice/lib/modules/payments/client.js";
import { configureBookingSaga, recoverOnce, transitions } from "../../bangkok-homeservice/lib/modules/booking/saga.js";

freshBoot();
const fenced = new Set();
const paymentsClient = {
  async createIntent(ctx, cred) { throw new PaymentOutcomeUnknownError("create", cred.commandId, fenced.has(cred.commandId) ? "fenced" : "timeout"); },
  async getOperation() { throw new Error("unused"); },
  async cancelIntent(ctx) { fenced.add(ctx.create_command_id); return { create_command_id: ctx.create_command_id, saga_id: ctx.saga_id, outcome: "cancelled" }; },
};
configureBookingSaga({ payments: createBookingPaymentsAdapter({ paymentsClient }), baseBackoffMs: 1, maxBackoffMs: 1, maxCreateAttempts: 3 });

const customer = await loginSeededCustomer("nong@example.com");
const provider = await loginSeededProvider("sparkle@example.com");
const addressId = getDb().prepare("SELECT id FROM addresses WHERE customer_id = ? LIMIT 1").get(customer.id).id;
const body = { provider_id: provider.id, address_id: addressId, service_date: futureWeekday(4), starting_time: "10:00",
  items: [{ service_id: 2, quantity: 1 }], payment_method: "gateway" };

const snapshot = (orderId, label) => {
  const o = getDb().prepare("SELECT status, payment_status FROM orders WHERE id = ?").get(orderId);
  const s = getDb().prepare("SELECT state, attempts FROM booking_sagas WHERE order_id = ?").get(orderId);
  const h = getDb().prepare("SELECT count(*) AS n FROM slot_holds WHERE order_id = ?").get(orderId).n;
  console.log(`${label.padEnd(28)} saga=${s.state.padEnd(22)} order=${o.status.padEnd(10)} slot_holds=${h}`);
};

const first = await call(bookings.POST, { token: customer.token, body, headers: { "idempotency-key": "demo-1" } });
console.log(`POST /api/bookings -> ${first.status} ${first.body.code}`);
const orderId = first.body.order_id;
snapshot(orderId, "BEFORE (after 1st attempt)");
for (let i = 0; i < 4; i += 1) { await new Promise((r) => setTimeout(r, 5)); await recoverOnce(); snapshot(orderId, `recovery pass ${i + 1}`); }
const sagaId = getDb().prepare("SELECT saga_id FROM booking_sagas WHERE order_id = ?").get(orderId).saga_id;
console.log("transitions:", transitions(sagaId).map((x) => `${x.from_state}->${x.to_state}`).join(", "));
const retry = await call(bookings.POST, { token: customer.token, body, headers: { "idempotency-key": "demo-1" } });
console.log(`retry same key -> ${retry.status} ${retry.body.code}`);
const rebook = await call(bookings.POST, { token: customer.token, body: { ...body, payment_method: "cod" } });
console.log(`same slot booked again (COD) -> ${rebook.status}`);
