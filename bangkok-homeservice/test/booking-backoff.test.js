// Area C: one jittered retry policy for saga steps and activation delivery (follow-up to D's #47).
import { freshBoot, getDb } from "../test-helpers/boot.js";
import test from "node:test";
import assert from "node:assert/strict";
import { retryDelay } from "../lib/modules/booking/backoff.js";
import { configureBookingSaga, activate } from "../lib/modules/booking/saga.js";
import { PaymentOutcomeUnknownError } from "../lib/modules/payments/client.js";

freshBoot();

test("retryDelay: capped exponential with equal jitter, never below half", () => {
  const p = { baseMs: 1000, maxMs: 30000 };
  assert.equal(retryDelay(1, { ...p, random: () => 0 }), 500);
  assert.equal(retryDelay(1, { ...p, random: () => 0.999999 }), 999);
  assert.equal(retryDelay(3, { ...p, random: () => 0 }), 2000);
  assert.equal(retryDelay(20, { ...p, random: () => 0 }), 15000, "cap applies before jitter");
  for (let i = 0; i < 200; i += 1) {
    const d = retryDelay(4, p);
    assert.ok(d >= 4000 && d < 8000, String(d));
  }
});

test("activation delivery uses the same jittered policy as saga steps", async () => {
  const db = getDb();
  const customer = db.prepare("SELECT id FROM customers ORDER BY id LIMIT 1").get().id;
  const provider = db.prepare("SELECT id FROM providers ORDER BY id LIMIT 1").get().id;
  const orderId = db.prepare(`INSERT INTO orders (customer_id,provider_id,service_date,starting_time,ending_time,duration_min,subtotal_cents,tax_cents,total_cents,commission_pct,payment_method,otp,status)
    VALUES (?,?,'2027-02-01','10:00','10:30',30,100,7,107,10,'gateway',123456,'awaiting')`).run(customer, provider).lastInsertRowid;
  db.prepare(`INSERT INTO booking_sagas (saga_id,order_id,customer_id,request_key,request_digest,state,create_command_id,cancel_command_id,snapshot_json,intent_json)
    VALUES ('saga-jitter',?,?,'k-jitter','d','COMPLETED','create:saga-jitter','cancel:saga-jitter','{}','{}')`).run(orderId, customer);
  db.prepare("INSERT INTO booking_saga_activations (saga_id, activate_command_id, state) VALUES ('saga-jitter','activate:saga-jitter','pending')").run();
  const payments = { activate: async () => { throw new PaymentOutcomeUnknownError("activate", "create:saga-jitter", "timeout"); } };
  for (const [random, low, high] of [[() => 0, 450, 600], [() => 0.999999, 950, 1100]]) {
    db.prepare("UPDATE booking_saga_activations SET attempts = 0, next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE saga_id = 'saga-jitter'").run();
    configureBookingSaga({ payments, baseBackoffMs: 1000, maxBackoffMs: 30000, random });
    const before = Date.now();
    await activate("saga-jitter");
    const row = db.prepare("SELECT attempts, next_attempt_at FROM booking_saga_activations WHERE saga_id = 'saga-jitter'").get();
    const delay = Date.parse(row.next_attempt_at) - before;
    assert.equal(row.attempts, 1);
    assert.ok(delay >= low && delay <= high, `delay ${delay} not in [${low}, ${high}]`);
  }
});
