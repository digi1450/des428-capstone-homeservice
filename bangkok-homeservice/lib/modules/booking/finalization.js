import {legacyBookingReference} from './legacy-binding.js';
import {processState} from '../../runtime/process-state.js';
import {currentCarrier,traced,traceFields} from '../../telemetry/context.js';
// Area C — Booking financial finalization (step 5C): durable completion/cancellation work,
// the synchronous local transition guard and recovery. Implements the four callbacks A's caller
// seam requires (configureBookingFinancialAccess({ bookingFinalization })).
// Baseline: docs/financial-finalization-decisions.md; wire contract v1.0.0.
//
//   complete  ONE SQLite transaction: recheck provider/OTP/'started', mark completed, emit the same
//             domain events as before, and save completion work (operation UUID + frozen snapshot).
//             No local wallet/ledger write. Accounting stays 'pending' until Payments confirms.
//   cancel    ONE SQLite transaction: recheck customer and a cancellable state, then save
//             cancellation work. The order stays awaiting/confirmed and the slot holds are KEPT.
//             Only a validated READY Payments result finalizes: cancelled + holds released +
//             refunded flag (only if Payments refunded) + status event, atomically.
//   status    current accounting/cancellation status from the durable work.
//   assertTransitionAllowed  synchronous, runs inside the caller's SQLite transaction: refuses
//             confirm/start/reschedule while a cancellation is pending or in attention.
//
// Delivery happens outside any SQLite transaction, under a per-claim lease token, always with the
// SAME saved command id and snapshot (never a new key per retry). Unknown outcomes stay pending;
// validated attention and reconciliation conflicts become attention + consistency_attention.
import { randomUUID } from "node:crypto";
import { getDb } from "../../db/index.js";
import { insertEvent } from "../../db/events.js";
import { logger } from "../../logger.js";
import { ConflictError, NotFoundError, ForbiddenError } from "../../errors.js";
import * as repository from "./repository.js";
import { retryDelay } from "./backoff.js";
import { toPublicOrder } from "./service.js";

export const WORK = Object.freeze({ PENDING: "pending", READY: "ready", ATTENTION: "attention" });
const BLOCKED_BY_CANCELLATION = new Set(["confirm", "start", "reschedule"]);

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const db = () => getDb();
const workFor = (orderId, kind) => db().prepare("SELECT * FROM booking_financial_work WHERE order_id = ? AND kind = ?").get(orderId, kind);
const workById = (operationId) => db().prepare("SELECT * FROM booking_financial_work WHERE operation_id = ?").get(operationId);
const sagaFor = (orderId) => db().prepare("SELECT saga_id, state, create_command_id FROM booking_sagas WHERE order_id = ?").get(orderId);

const selection=processState('modules/booking/finalization.js');
export const getBookingFinalizationRuntime = () => selection.value;

// financial = A's createFinancialClient(...) (complete/cancel with the saved work).
// credentials() = B's service-credential callback ({ token, requestId?, traceparent? }).
// Retry numbers are placeholders for D's policy, matching the saga defaults.
export function createBookingFinalization({ financial, credentials, baseBackoffMs = 1000, maxBackoffMs = 30000,
  leaseMs = 15000, escalateAfter = 5, random = Math.random, owner = `finalization-${process.pid}-${randomUUID().slice(0, 8)}` } = {}) {
  if (typeof financial?.complete !== "function" || typeof financial?.cancel !== "function") throw new TypeError("finalization requires A's financial client");
  if (typeof credentials !== "function") throw new TypeError("finalization requires a service credential callback");
  selection.value = { financial, credentials, baseBackoffMs, maxBackoffMs, leaseMs, escalateAfter, random, owner };
  return { complete, cancel, status, assertTransitionAllowed };
}
export function resetBookingFinalization() { selection.value = null; } // tests / drained shutdown only

// ------------------------------------------------------------------ snapshots
function snapshot(order, kind, operationId) {
  const request = {
    operation_id: operationId, order_id: order.id, customer_id: order.customer_id, provider_id: order.provider_id,
    amount_cents: order.total_cents, currency: "THB", payment_method: order.payment_method,
    ...(kind === "completion" ? { commission_cents: order.commission_cents } : { reason: "customer_cancelled" }),
  };
  if (order.payment_method === "gateway") {
    const saga = sagaFor(order.id);
    // Never fabricate provisioning references for legacy gateway bookings (A/C legacy gate).
    if (!saga) {
      const ref=legacyBookingReference(order.id);
      if(!ref)throw new ConflictError("legacy gateway booking requires financial reconciliation");
      request.legacy_binding=ref;
      return request;
    }
    if (db().prepare('SELECT 1 FROM booking_legacy_payment_bindings WHERE order_id=?').get(order.id))throw new ConflictError('ambiguous financial reference');
    if (kind === "completion" && saga.state !== "COMPLETED") throw new ConflictError("payment setup for this booking is still in progress");
    request.provisioning = { create_command_id: saga.create_command_id, saga_id: saga.saga_id };
  }
  return request;
}
function insertWork(kind, order) {
  const operationId = randomUUID();
  const request = snapshot(kind === "completion" ? repository.findOrderById(order.id) : order, kind, operationId);
  const commandId = `${kind === "completion" ? "complete" : "cancel"}:${operationId}`;
  db().prepare(`INSERT INTO booking_financial_work (operation_id, kind, order_id, command_id, request_json, state)
    VALUES (?, ?, ?, ?, ?, 'pending')`).run(operationId, kind, order.id, commandId, JSON.stringify(request));
  const carrier=currentCarrier();
  if(Object.keys(carrier).length)db().prepare('INSERT INTO booking_work_trace_context (operation_id,headers_json) VALUES (?,?)').run(operationId,JSON.stringify(carrier));
  return workById(operationId);
}

// ------------------------------------------------------------------ callbacks
async function complete({ orderId, providerId, otp }) {
  const work = db().transaction(() => {
    const order = repository.findOrderById(orderId);
    if (!order) throw new NotFoundError(`booking ${orderId} not found`);
    if (order.provider_id !== providerId) throw new ForbiddenError("you are not the provider on this booking");
    const existing = workFor(orderId, "completion");
    if (existing) { // replay of an accepted completion (A already rechecked provider + OTP)
      if (order.otp !== otp) throw new ConflictError("incorrect OTP");
      return existing;
    }
    if (order.status === "completed") throw new ConflictError("booking is already completed"); // legacy completion
    const cancellation = workFor(orderId, "cancellation");
    if (cancellation && cancellation.state !== WORK.READY) throw new ConflictError("financial transition is pending reconciliation");
    const commission = Math.round((order.total_cents * order.commission_pct) / 100);
    const earnings = order.total_cents - commission;
    if (repository.completeAtomic(orderId, providerId, otp, commission, earnings) === 0) {
      const fresh = repository.findOrderById(orderId);
      if (fresh.otp !== otp) throw new ConflictError("incorrect OTP");
      throw new ConflictError(`cannot complete booking from status '${fresh.status}'`);
    }
    const saved = insertWork("completion", order); // throws (rolls back) for a legacy gateway booking
    insertEvent("booking.completed", "order", orderId, {
      order_id: orderId, total_cents: order.total_cents, commission_cents: commission,
      provider_earnings_cents: earnings, customer_id: order.customer_id, provider_id: providerId,
    });
    insertEvent("booking.status_changed", "order", orderId, {
      order_id: orderId, from: "started", to: "completed",
      customer_id: order.customer_id, provider_id: providerId, actor_role: "provider",
    });
    return saved;
  }).immediate();
  await deliverNow(work);
  return completedView(orderId);
}

async function cancel({ orderId, customerId }) {
  const work = db().transaction(() => {
    const order = repository.findOrderById(orderId);
    if (!order) throw new NotFoundError(`booking ${orderId} not found`);
    if (order.customer_id !== customerId) throw new ForbiddenError("you are not the customer on this booking");
    const existing = workFor(orderId, "cancellation");
    if (existing) return existing; // one operation per accepted logical cancellation
    if (workFor(orderId, "completion")) throw new ConflictError("completed booking cannot be cancelled");
    if (!["awaiting", "confirmed"].includes(order.status)) throw new ConflictError(`cannot cancel booking from status '${order.status}'`);
    return insertWork("cancellation", order);
  }).immediate();
  await deliverNow(work);
  return cancellationView(orderId);
}

function status({ orderId }) {
  const out = {};
  const completion = workFor(orderId, "completion");
  const cancellation = workFor(orderId, "cancellation");
  if (completion) out.accounting_status = completion.state;
  if (cancellation) out.cancellation_status = cancellation.state;
  return out;
}

function assertTransitionAllowed({ orderId, operation }) {
  if (!BLOCKED_BY_CANCELLATION.has(operation)) return true;
  const cancellation = workFor(orderId, "cancellation");
  return !cancellation || cancellation.state === WORK.READY;
}

// ------------------------------------------------------------------ projections
function completedView(orderId) {
  const order = toPublicOrder(repository.findOrderById(orderId));
  return { ...order, accounting_status: workFor(orderId, "completion").state };
}
function cancellationView(orderId) {
  const work = workFor(orderId, "cancellation");
  const order = toPublicOrder(repository.findOrderById(orderId));
  if (work.state !== WORK.READY) return { order, cancellation_status: work.state };
  return { order, refunded: JSON.parse(work.result_json).outcome === "refunded", cancellation_status: "ready" };
}

// ------------------------------------------------------------------ delivery
async function deliverNow(work) {
  if (work.state !== WORK.PENDING || work.next_attempt_at > iso()) return;
  try { await deliver(work.operation_id); } catch (error) {
    logger.error({ operation: work.operation_id, err: error.message }, "financial delivery attempt failed");
  }
}

function attention(work, reason) {
  db().prepare("INSERT INTO consistency_attention (consumer_name, event_id, event_type, aggregate_id, reason) VALUES ('booking-finalization', ?, ?, ?, ?)")
    .run(work.command_id, `financial.${work.kind}`, String(work.order_id), reason);
}
// All result writes require the CURRENT claim token, so a stale worker changes nothing.
const settle = (work, token, state, fields = {}) => db().prepare(
  `UPDATE booking_financial_work SET state = ?, result_json = COALESCE(?, result_json), reason = ?, last_error = ?, updated_at = ?
    WHERE operation_id = ? AND state = 'pending' AND locked_by = ?`,
).run(state, fields.result ? JSON.stringify(fields.result) : null, fields.reason ?? null, fields.error ?? null, iso(), work.operation_id, token).changes === 1;

function finalizeCancellation(work, token, result) {
  const order = repository.findOrderById(work.order_id);
  const request = JSON.parse(work.request_json);
  const refunded = result.outcome === "refunded";
  if (!["awaiting", "confirmed"].includes(order.status) || (!refunded && order.payment_status === "paid")) {
    if (!settle(work, token, WORK.ATTENTION, { result, reason: "local_state_contradiction" })) return false;
    attention(work, "cancellation confirmed by Payments but the booking can no longer be finalized");
    return true;
  }
  if (!settle(work, token, WORK.READY, { result })) return false;
  if (repository.cancelAtomic(work.order_id, request.customer_id) !== 1) throw new Error("cancellation finalize raced");
  repository.deleteSlotHoldsForOrder(work.order_id);
  // Financial cancellation owns this lifecycle now. Stop provisioning/activation in the
  // SAME local commit; a late network reply must not recreate activation or release holds early.
  const saga = sagaFor(work.order_id);
  if (saga) {
    if (!["COMPLETED", "CANCELLED"].includes(saga.state)) {
      db().prepare("UPDATE booking_sagas SET state = 'CANCELLED', cancel_reason = 'customer_cancelled', updated_at = ? WHERE saga_id = ?").run(iso(), saga.saga_id);
      db().prepare("INSERT INTO booking_saga_transitions (saga_id, from_state, to_state, reason) VALUES (?, ?, 'CANCELLED', 'financial cancellation confirmed')").run(saga.saga_id, saga.state);
    }
    db().prepare("UPDATE booking_saga_activations SET state = 'blocked', last_error = 'financial_cancellation', updated_at = ? WHERE saga_id = ?").run(iso(), saga.saga_id);
  }
  if (refunded) repository.markRefunded(work.order_id);
  insertEvent("booking.status_changed", "order", work.order_id, {
    order_id: work.order_id, from: order.status, to: "cancelled",
    customer_id: request.customer_id, provider_id: order.provider_id, actor_role: "customer",
  });
  return true;
}

async function deliver(operationId) {
 const work=workById(operationId);if(!work)return work;
 const saved=db().prepare('SELECT headers_json FROM booking_work_trace_context WHERE operation_id=?').get(operationId);
 return traced('booking financial delivery',{carrier:saved?JSON.parse(saved.headers_json):{},attributes:{'booking.operation.id':operationId,'booking.command.id':work.command_id,'booking.work.kind':work.kind}},async span=>{
  const result=await deliverAttempt(operationId);
  span.setAttribute('booking.work.state',result.state);span.setAttribute('booking.work.attempts',result.attempts);
  if(result.state==='pending'&&result.attempts>work.attempts)span.setStatus({code:2});
  logger.info({event:'financial_delivery',operationId,commandId:work.command_id,workState:result.state,attempts:result.attempts,...traceFields()},'financial delivery');
  return result;
 });
}
async function deliverAttempt(operationId) {
  const rt = selection.value;
  if (!rt) return workById(operationId);
  const token = `${rt.owner}:${randomUUID()}`;
  const claimed = db().prepare(
    `UPDATE booking_financial_work SET locked_by = ?, locked_until = ?
      WHERE operation_id = ? AND state = 'pending' AND (locked_until IS NULL OR locked_until < ?)`,
  ).run(token, iso(rt.leaseMs), operationId, iso()).changes === 1;
  if (!claimed) return workById(operationId);
  const work = workById(operationId);
  try {
    const call = { commandId: work.command_id, request: JSON.parse(work.request_json) };
    let outcome;
    try {
      const result = await (work.kind === "completion" ? rt.financial.complete(call, await rt.credentials()) : rt.financial.cancel(call, await rt.credentials()));
      outcome = { kind: result.state, result };
    } catch (error) {
      outcome = error?.name === "FinancialReconciliationError"
        ? { kind: "conflict", error }
        : { kind: "unknown", error };
    }
    const applied = db().transaction(() => {
      if (outcome.kind === WORK.READY) {
        if (work.kind === "cancellation") return finalizeCancellation(work, token, outcome.result);
        return settle(work, token, WORK.READY, { result: outcome.result });
      }
      if (outcome.kind === WORK.ATTENTION || outcome.kind === "conflict") {
        const reason = outcome.kind === "conflict" ? (outcome.error.code ?? "uncoded_conflict") : outcome.result.reason;
        if (!settle(work, token, WORK.ATTENTION, { result: outcome.result, reason })) return false;
        attention(work, `financial ${work.kind} needs reconciliation: ${reason}`);
        return true;
      }
      // pending (accepted, e.g. awaiting settlement) or unknown: same key later, bounded backoff.
      const current = db().prepare("SELECT attempts FROM booking_financial_work WHERE operation_id = ? AND state = 'pending' AND locked_by = ?").get(operationId, token);
      if (!current) return false;
      const attempts = current.attempts + 1;
      const backoff = retryDelay(attempts, { baseMs: rt.baseBackoffMs, maxMs: rt.maxBackoffMs, random: rt.random });
      const lastError = outcome.kind === WORK.PENDING ? outcome.result.reason : String(outcome.error?.reason ?? outcome.error?.statusCode ?? outcome.error?.name ?? "error").slice(0, 120);
      db().prepare("UPDATE booking_financial_work SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE operation_id = ? AND locked_by = ?")
        .run(attempts, iso(backoff), lastError, iso(), operationId, token);
      const rejected = [401, 403].includes(outcome.error?.statusCode);
      if (outcome.kind === "unknown" && (attempts === rt.escalateAfter || (rejected && attempts === 1))) {
        attention(work, rejected ? "financial credentials rejected" : "financial outcome unconfirmed");
      }
      return true;
    }).immediate();
    if (!applied) logger.warn({ operation: operationId, outcome: outcome.kind }, "stale financial result discarded (lease was replaced)");
  } finally {
    db().prepare("UPDATE booking_financial_work SET locked_by = NULL, locked_until = NULL WHERE operation_id = ? AND locked_by = ?").run(operationId, token);
  }
  return workById(operationId);
}

// Delivers due pending work (restart, lost replies, awaiting settlement). Same saved key each time.
export async function recoverFinalizationOnce({ batchSize = 25 } = {}) {
  if (!selection.value) return 0;
  const due = db().prepare(
    `SELECT operation_id FROM booking_financial_work WHERE state = 'pending' AND next_attempt_at <= ?
      AND (locked_until IS NULL OR locked_until < ?) ORDER BY next_attempt_at LIMIT ?`,
  ).all(iso(), iso(), batchSize);
  for (const { operation_id: id } of due) {
    try { await deliver(id); } catch (error) { logger.error({ operation: id, err: error.message }, "financial recovery step failed"); }
  }
  return due.length;
}
export { deliver as deliverFinancialWork };
