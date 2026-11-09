// Area C — Payments participant in the Booking-orchestrated saga.
// Interface agreed in docs/c-payment-participant-interface.md (PRs #24/#25); A's router
// (src/command-router.js) injects this object as `paymentCommands`.
//
// Every command runs in ONE PostgreSQL transaction, in the agreed lock order:
//   1. command lock  pg_advisory_xact_lock(42802, hashtext(caller_id:create_command_id))
//   2. booking lock  pg_advisory_xact_lock(42801, order_id)  (A's lockOrder, re-entrant)
//   3. A's business primitives with the SAME client (intent / ledger / wallet)
// Provisioning state changes happen only while holding lock 2, so they serialize with
// settleWebhook, which holds lock 2 when it calls assertSettlementAllowed.
// No HTTP or other network call happens inside these transactions.
import { createHash } from "node:crypto";
import { HttpError } from "../errors.js";
import { orderFenced } from "../financial/index.js";

const conflict = (message, code) => {
  const error = new HttpError(409, message);
  if (code) error.code = code; // A serializes allow-listed codes (PAYMENT_SETUP_CANCELLED)
  return error;
};
export const SETUP_CANCELLED = "PAYMENT_SETUP_CANCELLED";

const canonical = value => JSON.stringify(Object.keys(value).sort().reduce((out, key) => ({ ...out, [key]: value[key] }), {}));
const digest = (kind, request) => createHash("sha256").update(kind + "\n" + canonical(request)).digest("hex");
const publicIntent = row => ({ id: row.id, order_id: row.order_id, amount_cents: row.amount_cents, gateway_ref: row.gateway_ref, status: row.status });
const cancelled = row => ({ create_command_id: row.create_command_id, saga_id: row.saga_id, outcome: "cancelled" });

export function createPaymentParticipant({ database, business }) {
  if (!database || typeof database.withTransaction !== "function") throw new TypeError("participant requires the Payments database");
  if (!business || typeof business.prepareIntent !== "function" || typeof business.voidUnpaidIntent !== "function") {
    throw new TypeError("participant requires A's business primitives");
  }
  const one = async (client, sql, values) => (await client.query(sql, values)).rows[0] ?? null;
  const lockProvisioning = (tx, callerId, createCommandId) =>
    tx.query("SELECT pg_advisory_xact_lock(42802, hashtext($1))", [`${callerId}:${createCommandId}`]);
  const lockOrder = (tx, orderId) => tx.query("SELECT pg_advisory_xact_lock(42801, $1::integer)", [orderId]);
  const provisioning = (tx, callerId, createCommandId) =>
    one(tx, "SELECT * FROM payment_provisioning WHERE caller_id=$1 AND create_command_id=$2", [callerId, createCommandId]);

  // Same command id + same kind/target/request -> stored row; anything else -> 409. Runs before effects.
  async function priorCommand(tx, callerId, commandId, kind, createCommandId, requestDigest) {
    const row = await one(tx, "SELECT * FROM payment_commands WHERE caller_id=$1 AND command_id=$2", [callerId, commandId]);
    if (row && (row.kind !== kind || row.create_command_id !== createCommandId || row.request_digest !== requestDigest)) {
      throw conflict("command id was already used for a different command");
    }
    return row;
  }
  async function storeCommand(tx, callerId, commandId, kind, createCommandId, requestDigest, result) {
    try {
      await tx.query(
        `INSERT INTO payment_commands (caller_id, command_id, kind, create_command_id, request_digest, result)
         VALUES ($1,$2,$3,$4,$5,$6)`, [callerId, commandId, kind, createCommandId, requestDigest, result]);
    } catch (error) {
      // The same command id raced for a different provisioning (a different command lock).
      if (error.code === "23505") throw conflict("command id was already used for a different command");
      throw error;
    }
  }

  return {
    async create({ callerId, commandId, request }) {
      const requestDigest = digest("create", request);
      return database.withTransaction(async tx => {
        await lockProvisioning(tx, callerId, commandId);
        const prior = await priorCommand(tx, callerId, commandId, "create", commandId, requestDigest);
        // Historical evidence: replayed unchanged even after a later fence. It does not mean "payable".
        if (prior) return { replayed: true, result: prior.result };
        const state = await provisioning(tx, callerId, commandId);
        if (state?.state === "fenced") throw conflict("payment setup was cancelled before this create arrived", SETUP_CANCELLED);
        if (state) throw conflict("provisioning exists without its create result");
        await lockOrder(tx, request.order_id);
        // Step 5C: a financial cancellation fence on this order also blocks a late create.
        if (await orderFenced(tx, request.order_id)) throw conflict("payment setup was cancelled before this create arrived", SETUP_CANCELLED);
        if (await one(tx, "SELECT 1 FROM payment_provisioning WHERE order_id=$1", [request.order_id])) {
          throw conflict("booking is already bound to another payment command");
        }
        // Legacy/imported intents have no provisioning row: never adopt them (separate A/C gate).
        if (await one(tx, "SELECT 1 FROM payment_intents WHERE order_id=$1", [request.order_id])) {
          throw conflict("existing intent requires reconciliation");
        }
        const intent = await business.prepareIntent({
          order_id: request.order_id, customer_id: request.customer_id, provider_id: request.provider_id,
          amount_cents: request.amount_cents, currency: request.currency,
        }, { client: tx });
        await tx.query(
          `INSERT INTO payment_provisioning (caller_id, create_command_id, saga_id, state, order_id, customer_id, provider_id, amount_cents, currency, intent_id)
           VALUES ($1,$2,$3,'created',$4,$5,$6,$7,$8,$9)`,
          [callerId, commandId, request.saga_id, request.order_id, request.customer_id, request.provider_id, request.amount_cents, request.currency, intent.id]);
        const result = { create_command_id: commandId, saga_id: request.saga_id, outcome: "created", payment_intent: intent };
        await storeCommand(tx, callerId, commandId, "create", commandId, requestDigest, result);
        return { replayed: false, result };
      });
    },

    // Current effective outcome; null = unknown (A maps to 404, never a fence).
    async get({ callerId, createCommandId }) {
      const state = await provisioning(database, callerId, createCommandId);
      if (!state) return null;
      if (state.state === "fenced") return cancelled(state);
      const intent = await one(database, "SELECT * FROM payment_intents WHERE id=$1", [state.intent_id]);
      return { create_command_id: state.create_command_id, saga_id: state.saga_id, outcome: "created", payment_intent: publicIntent(intent) };
    },

    async cancel({ callerId, commandId, request }) {
      const target = request.create_command_id;
      const requestDigest = digest("cancel", request);
      return database.withTransaction(async tx => {
        await lockProvisioning(tx, callerId, target);
        const prior = await priorCommand(tx, callerId, commandId, "cancel", target, requestDigest);
        if (prior) return prior.result;
        const state = await provisioning(tx, callerId, target);
        if (state && state.saga_id !== request.saga_id) throw conflict("cancellation references a different saga");
        if (!state) {
          // Absent-create fence: the create can never commit after this.
          await tx.query(
            `INSERT INTO payment_provisioning (caller_id, create_command_id, saga_id, state, cancel_command_id, cancel_reason)
             VALUES ($1,$2,$3,'fenced',$4,$5)`, [callerId, target, request.saga_id, commandId, request.reason]);
        } else if (state.state !== "fenced") {
          await lockOrder(tx, state.order_id);
          // Settled/completed intents throw 409 here: refund/reconciliation, and NO fence is written.
          await business.voidUnpaidIntent(state.order_id, { client: tx });
          await tx.query(
            `UPDATE payment_provisioning SET state='fenced', cancel_command_id=$3, cancel_reason=$4, updated_at=now()
             WHERE caller_id=$1 AND create_command_id=$2`, [callerId, target, commandId, request.reason]);
        }
        const result = { create_command_id: target, saga_id: request.saga_id, outcome: "cancelled" };
        await storeCommand(tx, callerId, commandId, "cancel", target, requestDigest, result);
        return result;
      });
    },

    // Enables settlement for a created provisioning. Always re-checks the effective fence,
    // including on replay, so historical acceptance is never mistaken for current readiness.
    async activate({ callerId, commandId, request }) {
      const target = request.create_command_id;
      const requestDigest = digest("activate", request);
      return database.withTransaction(async tx => {
        await lockProvisioning(tx, callerId, target);
        const prior = await priorCommand(tx, callerId, commandId, "activate", target, requestDigest);
        const state = await provisioning(tx, callerId, target);
        if (state?.state === "fenced") throw conflict("payment setup was cancelled", SETUP_CANCELLED);
        if (!state || state.saga_id !== request.saga_id) throw conflict("no matching payment provisioning to activate");
        // Step 5C: a refunded cancellation leaves provisioning 'activated' but fences the order.
        if (await orderFenced(tx, state.order_id)) throw conflict("payment setup was cancelled", SETUP_CANCELLED);
        if (prior) return { replayed: true, result: prior.result };
        if (state.state === "created") {
          await lockOrder(tx, state.order_id);
          await tx.query(
            `UPDATE payment_provisioning SET state='activated', activate_command_id=$3, updated_at=now()
             WHERE caller_id=$1 AND create_command_id=$2`, [callerId, target, commandId]);
        }
        const result = { create_command_id: target, saga_id: request.saga_id, outcome: "activated" };
        await storeCommand(tx, callerId, commandId, "activate", target, requestDigest, result);
        return { replayed: false, result };
      });
    },

    // Hook for A's settleWebhook: runs inside its transaction, which already holds lock 2.
    async assertSettlementAllowed(client, intent) {
      const state = await one(client, "SELECT state, intent_id FROM payment_provisioning WHERE order_id=$1", [intent.order_id]);
      if (await orderFenced(client, intent.order_id)) return false; // step 5C financial cancellation fence
      return state?.state === "activated" && state.intent_id === intent.id;
    },
  };
}
