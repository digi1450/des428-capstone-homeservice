// Area C — durable financial finalization participant (step 5C, contract v1.0.0).
// A's financial router (src/financial-router.js) injects this as `financialOperations` through
// createPaymentsRuntime({ createFinancialOperations }). Policies: docs/financial-finalization-decisions.md.
//
// Every command runs in ONE PostgreSQL transaction. Lock order (never reversed anywhere):
//   1. financial command  pg_advisory_xact_lock(42803, hashtext(caller_id:command_id))
//   2. provisioning       pg_advisory_xact_lock(42802, hashtext(caller_id:create_command_id))  (cancel, gateway)
//   3. order              pg_advisory_xact_lock(42801, order_id)  (A's lockOrder; settleWebhook holds it too)
// All decisions are made after lock 3, so completion, cancellation and settlement are serialized
// per order. Command row + result + fence + money effects commit together or not at all.
// No HTTP or other network call happens inside these transactions.
//
// Outcomes:
//   ready      terminal safe result, replayed verbatim for the same caller/key/request
//   pending    durably accepted, re-evaluated on every retry of the same key (never a new key)
//   attention  durable reconciliation needed; replayed, never retried into success
//   coded 409  the command was NOT accepted (nothing stored): changed request for a key, another
//              key for the same order operation, or an operation blocked by in-flight work
import { createHash } from "node:crypto";
import { HttpError } from "../errors.js";

export const CODES = Object.freeze({
  COMMAND_CONFLICT: "FINANCIAL_COMMAND_CONFLICT",
  CONTEXT_MISMATCH: "FINANCIAL_CONTEXT_MISMATCH",
  OPERATION_BLOCKED: "FINANCIAL_OPERATION_BLOCKED",
  LEGACY: "FINANCIAL_LEGACY_RECONCILIATION_REQUIRED",
});
const coded = (code, message) => {
  const error = new HttpError(409, message);
  error.code = code;
  return error;
};

// Deep canonical JSON (keys sorted at every level) so a nested provisioning object with the same
// content always produces the same digest.
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`
  : JSON.stringify(value);
const digest = (kind, request) => createHash("sha256").update(`${kind}\n${canonical(request)}`).digest("hex");
const matches = (row, request) => row.order_id === request.order_id && row.customer_id === request.customer_id
  && row.provider_id === request.provider_id && row.amount_cents === request.amount_cents;
const SETTLED_LEDGER = ["payout_credit", "commission_owed"];

export function createFinancialOperations({ database, business }) {
  if (!database || typeof database.withTransaction !== "function") throw new TypeError("financial operations require the Payments database");
  for (const name of ["applyCompletion", "applyRefund", "voidUnpaidIntent"]) {
    if (typeof business?.[name] !== "function") throw new TypeError(`financial operations require A's ${name}`);
  }
  const one = async (client, sql, values) => (await client.query(sql, values)).rows[0] ?? null;
  const all = async (client, sql, values) => (await client.query(sql, values)).rows;
  const lockCommand = (tx, callerId, commandId) => tx.query("SELECT pg_advisory_xact_lock(42803, hashtext($1))", [`${callerId}:${commandId}`]);
  const lockProvisioning = (tx, callerId, createCommandId) => tx.query("SELECT pg_advisory_xact_lock(42802, hashtext($1))", [`${callerId}:${createCommandId}`]);
  const lockOrder = (tx, orderId) => tx.query("SELECT pg_advisory_xact_lock(42801, $1::integer)", [orderId]);
  const command = (tx, callerId, commandId) => one(tx, "SELECT * FROM financial_commands WHERE caller_id=$1 AND command_id=$2", [callerId, commandId]);

  // Same key: same kind + request digest, else the command is rejected without touching the stored row.
  async function prior(tx, callerId, commandId, kind, requestDigest) {
    const row = await command(tx, callerId, commandId);
    if (row && (row.kind !== kind || row.request_digest !== requestDigest)) {
      throw coded(CODES.COMMAND_CONFLICT, "financial command key was already used for a different request");
    }
    return row;
  }
  async function other(tx, kind, orderId, callerId, commandId) {
    const row = await one(tx, "SELECT caller_id, command_id, state FROM financial_commands WHERE kind=$1 AND order_id=$2", [kind, orderId]);
    return row && !(row.caller_id === callerId && row.command_id === commandId) ? row : null;
  }
  async function save(tx, { callerId, commandId, kind, request, requestDigest, existing }, result) {
    if (existing) {
      await tx.query("UPDATE financial_commands SET state=$3, result=$4, updated_at=now() WHERE caller_id=$1 AND command_id=$2",
        [callerId, commandId, result.state, result]);
    } else {
      await tx.query(
        `INSERT INTO financial_commands (caller_id, command_id, kind, operation_id, order_id, request_digest, request, state, result)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [callerId, commandId, kind, request.operation_id, request.order_id, requestDigest, request, result.state, result]);
    }
    return result;
  }
  const base = (kind, commandId, request) => ({ command_id: commandId, kind, request });
  const fenceFor = (tx, orderId) => one(tx, "SELECT * FROM financial_fences WHERE order_id=$1", [orderId]);
  const ledger = (tx, orderId) => all(tx, "SELECT * FROM transactions WHERE order_id=$1 ORDER BY id", [orderId]);
  const intentFor = (tx, orderId) => one(tx, "SELECT * FROM payment_intents WHERE order_id=$1", [orderId]);
  const provisioningFor = (tx, orderId) => one(tx, "SELECT * FROM payment_provisioning WHERE order_id=$1", [orderId]);

  // Gateway provisioning reference check shared by completion and cancellation.
  // Returns null when consistent, otherwise the attention reason.
  function provisioningProblem(request, callerId, provisioning, intent) {
    if (!provisioning) return intent ? "legacy_reconciliation_required" : "context_mismatch";
    if (provisioning.caller_id !== callerId || provisioning.create_command_id !== request.provisioning.create_command_id
      || provisioning.saga_id !== request.provisioning.saga_id) return "context_mismatch";
    if (intent && (!matches(intent, request) || provisioning.intent_id !== intent.id)) return "context_mismatch";
    return null;
  }

  // ---------------------------------------------------------------- completion
  async function evaluateCompletion(tx, callerId, commandId, request) {
    const attention = (reason) => ({ ...base("completion", commandId, request), state: "attention", reason });
    const pending = (reason) => ({ ...base("completion", commandId, request), state: "pending", reason });
    if (await fenceFor(tx, request.order_id)) return attention("cancellation_fenced");
    const intent = await intentFor(tx, request.order_id);
    const entries = await ledger(tx, request.order_id);
    if (entries.some((row) => row.kind === "refund")) return attention("settlement_contradiction");
    const accounted = entries.find((row) => SETTLED_LEDGER.includes(row.kind));

    if (request.payment_method === "gateway") {
      const problem = provisioningProblem(request, callerId, await provisioningFor(tx, request.order_id), intent);
      if (problem) return attention(problem);
      if (!intent) return attention("context_mismatch");
      if (intent.status === "failed") return attention("cancellation_fenced");
      const charge = entries.find((row) => row.kind === "charge");
      if (intent.status !== "succeeded" || !charge) {
        if (accounted) return attention("settlement_contradiction"); // payout recorded without a charge
        return pending("awaiting_settlement"); // never credit a payout from a merely existing intent
      }
      if (charge.status !== "succeeded" || charge.method !== "gateway" || !matches(charge, request)) return attention("settlement_contradiction");
    } else if (intent) {
      return attention("context_mismatch"); // a gateway booking cannot complete as COD
    }
    let transaction;
    try {
      // A's primitive with C's SAME client: idempotent on the order (returns the prior ledger row).
      transaction = await business.applyCompletion({
        order_id: request.order_id, customer_id: request.customer_id, provider_id: request.provider_id,
        amount_cents: request.amount_cents, commission_cents: request.commission_cents, payment_method: request.payment_method,
      }, { client: tx });
    } catch (error) {
      if (error?.statusCode === 409) return attention("context_mismatch");
      throw error;
    }
    return { ...base("completion", commandId, request), state: "ready",
      accounting: { transaction_id: transaction.id, kind: transaction.kind, amount_cents: transaction.amount_cents } };
  }

  // -------------------------------------------------------------- cancellation
  async function evaluateCancellation(tx, callerId, commandId, request) {
    const attention = (reason) => ({ ...base("cancellation", commandId, request), state: "attention", reason });
    const ready = (outcome, extra = {}) => ({ ...base("cancellation", commandId, request), state: "ready", settlement_fenced: true, outcome, ...extra });
    const fence = await fenceFor(tx, request.order_id);
    if (fence) throw coded(CODES.COMMAND_CONFLICT, "order is already fenced by another financial cancellation");
    const completion = await one(tx, "SELECT state FROM financial_commands WHERE kind='completion' AND order_id=$1", [request.order_id]);
    const entries = await ledger(tx, request.order_id);
    if (entries.some((row) => SETTLED_LEDGER.includes(row.kind)) || completion?.state === "ready") return attention("completion_accounted");
    // In-flight completion work: refuse without storing, so Booking keeps its guard and reconciles.
    if (completion) throw coded(CODES.OPERATION_BLOCKED, "completion work for this order is still in progress");
    const intent = await intentFor(tx, request.order_id);
    let result;

    if (request.payment_method === "cod") {
      if (intent) return attention("context_mismatch");
      result = ready("no_payment");
    } else {
      const provisioning = await provisioningFor(tx, request.order_id);
      if (!provisioning) {
        if (intent) return attention("legacy_reconciliation_required");
        const sameKey = await one(tx, "SELECT * FROM payment_provisioning WHERE caller_id=$1 AND create_command_id=$2",
          [callerId, request.provisioning.create_command_id]);
        // Only a genuine order-less absent-create fence belongs in this branch.
        // A matching saga string does not permit reusing another order's bound key.
        if (sameKey && (sameKey.saga_id !== request.provisioning.saga_id || sameKey.state !== "fenced"
          || ["order_id", "intent_id", "customer_id", "provider_id", "amount_cents", "currency"].some((field) => sameKey[field] !== null))) {
          return attention("context_mismatch");
        }
        if (!sameKey) {
          // Absent-create fence (same protocol as the provisioning participant): a late create for
          // this saga can never commit afterwards.
          await tx.query(
            `INSERT INTO payment_provisioning (caller_id, create_command_id, saga_id, state, cancel_command_id, cancel_reason,
              order_id, customer_id, provider_id, amount_cents, currency)
             VALUES ($1,$2,$3,'fenced',$4,'financial_cancellation',$5,$6,$7,$8,$9)`,
            [callerId, request.provisioning.create_command_id, request.provisioning.saga_id, commandId,
              request.order_id, request.customer_id, request.provider_id, request.amount_cents, request.currency]);
        } else {
          // Preserve an existing setup-compensation fence/key, but bind its previously
          // unknown context once. The same create reference cannot later fence another order.
          await tx.query(
            `UPDATE payment_provisioning SET order_id=$3, customer_id=$4, provider_id=$5, amount_cents=$6, currency=$7, updated_at=now()
             WHERE caller_id=$1 AND create_command_id=$2`,
            [callerId, request.provisioning.create_command_id, request.order_id, request.customer_id,
              request.provider_id, request.amount_cents, request.currency]);
        }
        result = ready("no_payment");
      } else {
        const problem = provisioningProblem(request, callerId, provisioning, intent);
        if (problem) return attention(problem);
        const charge = entries.find((row) => row.kind === "charge");
        if (intent?.status === "succeeded") {
          if (!charge || charge.status !== "succeeded" || !matches(charge, request)) return attention("settlement_contradiction");
          let refund;
          try {
            refund = await business.applyRefund({ order_id: request.order_id, customer_id: request.customer_id,
              provider_id: request.provider_id, amount_cents: request.amount_cents }, { client: tx });
          } catch (error) {
            if (error?.statusCode === 409) return attention("settlement_contradiction");
            throw error;
          }
          result = ready("refunded", { refund_transaction_id: refund.id });
        } else if (charge) {
          return attention("settlement_contradiction"); // a charge without a succeeded intent
        } else if (intent) {
          const voided = await business.voidUnpaidIntent(request.order_id, { client: tx }); // idempotent for 'failed'
          result = ready("voided", { voided_intent_id: voided.id });
        } else {
          result = ready("no_payment");
        }
        if (provisioning.state !== "fenced" && result.outcome !== "refunded") {
          await tx.query(
            `UPDATE payment_provisioning SET state='fenced', cancel_command_id=$2, cancel_reason='financial_cancellation', updated_at=now()
             WHERE order_id=$1`, [request.order_id, commandId]);
        }
      }
    }
    return result;
  }

  async function run(kind, { callerId, commandId, request }) {
    const requestDigest = digest(kind, request);
    return database.withTransaction(async (tx) => {
      await lockCommand(tx, callerId, commandId);
      const existing = await prior(tx, callerId, commandId, kind, requestDigest);
      if (existing && existing.state !== "pending") return { replayed: true, result: existing.result };
      // Serialize the one-command-per-order decision with evaluation and INSERT.
      // Different command keys hold different command locks; checking before the
      // order lock would let both see "absent" and leak UNIQUE violations as 500.
      if (kind === "cancellation" && request.payment_method === "gateway") {
        await lockProvisioning(tx, callerId, request.provisioning.create_command_id);
      }
      await lockOrder(tx, request.order_id);
      const elsewhere = await other(tx, kind, request.order_id, callerId, commandId);
      if (elsewhere) throw coded(CODES.COMMAND_CONFLICT, `order already has a different ${kind} command`);
      const result = kind === "completion"
        ? await evaluateCompletion(tx, callerId, commandId, request)
        : await evaluateCancellation(tx, callerId, commandId, request);
      await save(tx, { callerId, commandId, kind, request, requestDigest, existing }, result);
      if (kind === "cancellation" && result.state === "ready") {
        await tx.query("INSERT INTO financial_fences (order_id, caller_id, command_id, outcome) VALUES ($1,$2,$3,$4)",
          [request.order_id, callerId, commandId, result.outcome]);
      }
      return { replayed: false, result }; // a pending retry is a fresh evaluation, not a replay
    });
  }

  return {
    complete: (input) => run("completion", input),
    cancel: (input) => run("cancellation", input),
    // Read-only lookup, scoped to the authenticated caller. null = unknown (A maps to 404).
    async get({ callerId, commandId }) {
      return (await command(database, callerId, commandId))?.result ?? null;
    },
  };
}

// Used by the provisioning participant and its settlement gate (same transaction/client).
export async function orderFenced(client, orderId) {
  return Boolean((await client.query("SELECT 1 FROM financial_fences WHERE order_id=$1", [orderId])).rows[0]);
}
