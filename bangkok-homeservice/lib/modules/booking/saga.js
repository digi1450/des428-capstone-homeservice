// Area C — Booking-orchestrated provisioning saga for gateway bookings (Week 8 slides 20–23,
// Week 10 orchestration; decisions in docs/migration-handoff.md §5).
//
//   local T1  reserve booking + items + slot holds + saga row        (one IMMEDIATE SQLite tx)
//   remote    Payments: create intent with a stable create_command_id (NO SQLite tx held open)
//   local T2  finalize: saga COMPLETED + booking.status_changed outbox event
//
//   compensation (reverse order): Payments cancel-by-command (fence: the create can never commit
//   later) THEN local cancel booking + release slot holds; history is kept.
//
// The rules that make it safe:
//   * An unknown outcome (timeout, lost reply, any HTTP error) is NOT failure: the saga stays
//     INTENT_CREATE_PENDING, keeps its slots and command id, and is retried with the SAME command.
//   * Slots are released only after Payments CONFIRMS the cancellation fence.
//   * A failed compensation stays COMPENSATION_PENDING, then RECOVERY_PENDING for a person —
//     never falsely CANCELLED.
//   * The customer's Idempotency-Key maps to one saga: a retry resumes it and finally replays the
//     original 201 body; the same key with a different request is a 409.
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { getDb } from "../../db/index.js";
import { logger } from "../../logger.js";
import { ConflictError } from "../../errors.js";
import * as repository from "./repository.js";
import { reserveBooking, emitBookingPlaced, toPublicOrder } from "./service.js";

export const STATES = Object.freeze({
  CREATE_PENDING: "INTENT_CREATE_PENDING",
  COMPLETED: "COMPLETED",
  COMPENSATION_PENDING: "COMPENSATION_PENDING",
  CANCELLED: "CANCELLED",
  RECOVERY_PENDING: "RECOVERY_PENDING",
});
const ACTIVE = [STATES.CREATE_PENDING, STATES.COMPENSATION_PENDING];
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

let runtime = null;

// payments: A's createBookingPaymentsAdapter({ paymentsClient }) (prepare / cancel).
// credentials: async () => service-caller credentials from B (token etc.).
// Not configured by default: POST /api/bookings keeps the inherited flow until A/B wire this.
export function configureBookingSaga({ payments, credentials = async () => ({}), maxCreateAttempts = 5,
  maxCancelAttempts = 5, baseBackoffMs = 1000, maxBackoffMs = 30000, leaseMs = 15000, retryAfterSeconds = 2 } = {}) {
  runtime = { payments, credentials, maxCreateAttempts, maxCancelAttempts, baseBackoffMs, maxBackoffMs, leaseMs, retryAfterSeconds,
    owner: `booking-saga:${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}` };
  return runtime;
}
export function getBookingSaga() { return runtime; }
export function resetBookingSaga() { runtime = null; }

function digest(input) {
  const canonical = {
    provider_id: input.provider_id, address_id: input.address_id ?? null, service_date: input.service_date,
    starting_time: input.starting_time, payment_method: input.payment_method,
    items: input.items.map((i) => ({ service_id: i.service_id, quantity: i.quantity })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

const find = (sagaId) => getDb().prepare("SELECT * FROM booking_sagas WHERE saga_id = ?").get(sagaId);
const findByKey = (customerId, key) => getDb().prepare("SELECT * FROM booking_sagas WHERE customer_id = ? AND request_key = ?").get(customerId, key);
export const transitions = (sagaId) => getDb().prepare("SELECT from_state, to_state, reason FROM booking_saga_transitions WHERE saga_id = ? ORDER BY id").all(sagaId);

function move(saga, to, reason, fields = {}) {
  const db = getDb();
  const sets = ["state = ?", "attempts = 0", "next_attempt_at = ?", "last_error = NULL", "updated_at = ?"];
  const values = [to, iso(), iso()];
  for (const [column, value] of Object.entries(fields)) { sets.push(`${column} = ?`); values.push(value); }
  const changed = db.prepare(`UPDATE booking_sagas SET ${sets.join(", ")} WHERE saga_id = ? AND state = ?`).run(...values, saga.saga_id, saga.state).changes;
  if (changed !== 1) throw new Error(`saga ${saga.saga_id} moved concurrently`);
  db.prepare("INSERT INTO booking_saga_transitions (saga_id, from_state, to_state, reason) VALUES (?, ?, ?, ?)").run(saga.saga_id, saga.state, to, reason ?? null);
}

function claimLease(sagaId) {
  return getDb().prepare(
    "UPDATE booking_sagas SET locked_by = ?, locked_until = ? WHERE saga_id = ? AND (locked_until IS NULL OR locked_until < ?)",
  ).run(runtime.owner, iso(runtime.leaseMs), sagaId, iso()).changes === 1;
}
function releaseLease(sagaId) {
  getDb().prepare("UPDATE booking_sagas SET locked_by = NULL, locked_until = NULL WHERE saga_id = ? AND locked_by = ?").run(sagaId, runtime.owner);
}

function recordFailure(saga, error, limit, exhaustedTo, exhaustedReason) {
  const attempts = saga.attempts + 1;
  const kind = error?.reason ?? error?.name ?? "error";
  getDb().transaction(() => {
    if (attempts >= limit) {
      move(saga, exhaustedTo, `${exhaustedReason} after ${attempts} unconfirmed attempts (${kind})`,
        exhaustedTo === STATES.COMPENSATION_PENDING ? { cancel_reason: "booking_setup_failed" } : {});
    } else {
      const backoff = Math.min(runtime.maxBackoffMs, runtime.baseBackoffMs * 2 ** (attempts - 1));
      getDb().prepare("UPDATE booking_sagas SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE saga_id = ?")
        .run(attempts, iso(backoff), String(kind).slice(0, 120), iso(), saga.saga_id);
    }
  }).immediate();
}

// One step for one saga. Never holds a SQLite transaction across a network call.
async function step(saga) {
  const snapshot = JSON.parse(saga.snapshot_json);
  const workflow = { createCommandId: saga.create_command_id, sagaId: saga.saga_id };
  if (saga.state === STATES.CREATE_PENDING) {
    let operation;
    try {
      operation = await runtime.payments.prepare(snapshot, workflow, await runtime.credentials());
    } catch (error) {
      recordFailure(saga, error, runtime.maxCreateAttempts, STATES.COMPENSATION_PENDING, "setup abandoned");
      return;
    }
    try {
      getDb().transaction(() => {
        move(saga, STATES.COMPLETED, "payment intent created", { intent_json: JSON.stringify(operation.payment_intent) });
        emitBookingPlaced(saga.order_id, snapshot.customer_id, snapshot.provider_id); // deferred outbox event
      }).immediate();
    } catch (error) {
      // The intent exists but Booking could not finalize: void it by command, then cancel locally.
      logger.error({ saga: saga.saga_id, err: error.message }, "saga finalize failed");
      getDb().transaction(() => move(find(saga.saga_id), STATES.COMPENSATION_PENDING, "finalize failed",
        { cancel_reason: "booking_finalization_failed" })).immediate();
    }
    return;
  }
  if (saga.state === STATES.COMPENSATION_PENDING) {
    try {
      await runtime.payments.cancel({ ...workflow, cancelCommandId: saga.cancel_command_id, reason: saga.cancel_reason }, await runtime.credentials());
    } catch (error) {
      recordFailure(saga, error, runtime.maxCancelAttempts, STATES.RECOVERY_PENDING, "compensation unconfirmed");
      return;
    }
    // Fence confirmed: the create can no longer commit. Now undo T1 — keep the rows as history.
    getDb().transaction(() => {
      repository.cancelAtomic(saga.order_id, saga.customer_id);
      repository.deleteSlotHoldsForOrder(saga.order_id);
      move(saga, STATES.CANCELLED, `compensated (${saga.cancel_reason})`);
    }).immediate();
  }
}

// Advance a saga by at most one step, under a lease so two workers never drive it at once.
export async function advance(sagaId) {
  if (!claimLease(sagaId)) return find(sagaId);
  try {
    const saga = find(sagaId);
    if (ACTIVE.includes(saga.state)) await step(saga);
  } finally {
    releaseLease(sagaId);
  }
  return find(sagaId);
}

function response(saga) {
  if (saga.state === STATES.COMPLETED) {
    const order = repository.findOrderById(saga.order_id);
    return { statusCode: 201, body: { order: toPublicOrder(order), otp: order.otp, payment_intent: JSON.parse(saga.intent_json) },
      headers: { Location: `/api/bookings/${saga.order_id}` } };
  }
  if (saga.state === STATES.CANCELLED) {
    return { statusCode: 409, body: { error: "the booking could not be set up and was cancelled; no payment was taken", code: "BOOKING_SETUP_FAILED" }, headers: {} };
  }
  // Safe pending answer: same key later resumes the same saga (never a second reservation).
  return { statusCode: 503, body: { error: "the booking is still being confirmed; retry with the same Idempotency-Key", code: "BOOKING_PENDING", order_id: saga.order_id },
    headers: { "Retry-After": String(runtime.retryAfterSeconds) } };
}

export async function placeGatewayBooking(customerId, input, idempotencyKey) {
  if (!runtime) throw new Error("booking saga is not configured");
  const key = idempotencyKey ?? `auto:${randomUUID()}`;
  const requestDigest = digest(input);
  let saga = findByKey(customerId, key);
  if (!saga) {
    const sagaId = `saga-${randomUUID()}`;
    try {
      getDb().transaction(() => {
        const { orderId } = reserveBooking(customerId, input, { localIntent: false, emitAwaiting: false });
        const order = repository.findOrderById(orderId);
        const snapshot = { id: order.id, customer_id: order.customer_id, provider_id: order.provider_id,
          total_cents: order.total_cents, payment_method: order.payment_method };
        getDb().prepare(
          `INSERT INTO booking_sagas (saga_id, order_id, customer_id, request_key, request_digest, state, create_command_id, cancel_command_id, snapshot_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(sagaId, orderId, customerId, key, requestDigest, STATES.CREATE_PENDING, `create:${sagaId}`, `cancel:${sagaId}`, JSON.stringify(snapshot));
        getDb().prepare("INSERT INTO booking_saga_transitions (saga_id, from_state, to_state, reason) VALUES (?, 'BOOKING_RESERVED', ?, 'reserved')")
          .run(sagaId, STATES.CREATE_PENDING);
      }).immediate();
    } catch (error) {
      // A concurrent request with the same key won the unique (customer, key) race: resume it.
      if (String(error.code).startsWith("SQLITE_CONSTRAINT") && findByKey(customerId, key)) saga = findByKey(customerId, key);
      else throw error;
    }
    saga = saga ?? find(sagaId);
  }
  if (saga.request_digest !== requestDigest) throw new ConflictError("Idempotency-Key has already been used for a different request");
  if (ACTIVE.includes(saga.state) && saga.next_attempt_at <= iso()) saga = await advance(saga.saga_id);
  return response(saga);
}

// Recovery: drive every due saga one step (after restarts, outages or a 503 the client never retried).
export async function recoverOnce({ batchSize = 20 } = {}) {
  const due = getDb().prepare(
    `SELECT saga_id FROM booking_sagas WHERE state IN (?, ?) AND next_attempt_at <= ? AND (locked_until IS NULL OR locked_until < ?)
      ORDER BY next_attempt_at LIMIT ?`,
  ).all(...ACTIVE, iso(), iso(), batchSize);
  for (const { saga_id: sagaId } of due) {
    try { await advance(sagaId); } catch (error) { logger.error({ saga: sagaId, err: error.message }, "saga recovery step failed"); }
  }
  return due.length;
}

const RECOVERY = Symbol.for("edemand.booking-saga.recovery");
export function startSagaRecovery({ intervalMs = 2000 } = {}) {
  if (globalThis[RECOVERY]) return;
  const handle = setInterval(() => { recoverOnce().catch((error) => logger.error({ err: error.message }, "saga recovery failed")); }, intervalMs);
  handle.unref?.();
  globalThis[RECOVERY] = handle;
}
export function stopSagaRecovery() {
  if (globalThis[RECOVERY]) { clearInterval(globalThis[RECOVERY]); globalThis[RECOVERY] = undefined; }
}
