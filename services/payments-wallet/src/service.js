import { randomUUID } from "node:crypto";
import { createPaymentsRepository } from "./repository.js";
import { HttpError } from "./errors.js";
import { context, id, cents, principal, webhook } from "./validation.js";

const conflict = message => new HttpError(409, message);
const matches = (row, value) => ["order_id","customer_id","provider_id","amount_cents"].every(key => row[key] === value[key]);
const publicIntent = row => ({ id: row.id, order_id: row.order_id, amount_cents: row.amount_cents, gateway_ref: row.gateway_ref, status: row.status });
const publicTransaction = row => ({ id: row.id, order_id: row.order_id, kind: row.kind, amount_cents: row.amount_cents, method: row.method, gateway_ref: row.gateway_ref, status: row.status, created_at: new Date(row.created_at).toISOString() });

// Trusted internal business primitives. These do NOT implement C's HTTP command
// results, absent-create cancellation fence, provisioning saga or broker outbox.
export function createPaymentsService(database, { assertSettlementAllowed, stageEvent } = {}) {
  const repo = createPaymentsRepository(database);
  const write = (client, work) => client ? work(client) : database.withTransaction(work);
  const operations = {
    async prepareIntent(input, { client } = {}) {
      const value = context(input);
      if (input.currency !== "THB") throw new HttpError(400, "unsupported currency");
      return write(client, async tx => {
        await repo.lockOrder(tx,value.order_id);
        let row = await repo.intentByOrder(tx,value.order_id);
        if (row && (!matches(row,value) || row.status === "failed")) throw conflict("intent context conflicts or is voided");
        if (!row) {
          if ((await repo.ledgerForOrder(tx,value.order_id)).length) throw conflict("existing financial effects require reconciliation");
          row = await repo.insertIntent(tx,value,`SIM-PI-${randomUUID()}`);
        }
        return publicIntent(row);
      });
    },
    async getIntentForOrder(orderId, actor) {
      id(orderId,"order id");
      const who = principal(actor);
      const row = await repo.intentByOrder(database,orderId);
      if (!row) throw new HttpError(404,"payment intent not found");
      const owner = who.role === "customer" ? row.customer_id : who.role === "provider" ? row.provider_id : null;
      if (who.domainId !== owner) throw new HttpError(403,"not your payment intent");
      return publicIntent(row);
    },
    async voidUnpaidIntent(orderId, { client } = {}) {
      id(orderId,"order id");
      return write(client,async tx => {
        await repo.lockOrder(tx,orderId);
        const row = await repo.intentByOrder(tx,orderId);
        // Absence is NOT a durable fence and not permission to release slots.
        if (!row) throw new HttpError(404,"payment intent not found; create outcome remains unknown");
        if (row.status === "succeeded") throw conflict("settled intent requires refund, not void");
        if ((await repo.ledgerForOrder(tx,orderId)).some(item => item.kind === "payout_credit")) throw conflict("completed intent cannot void");
        return publicIntent(row.status === "failed" ? row : await repo.setIntentStatus(tx,row.id,"failed"));
      });
    },
    async provisionWallet(providerId, { client } = {}) {
      id(providerId,"provider id");
      return write(client,async tx => {
        const wallet = await repo.ensureWallet(tx,providerId);
        return { provider_id: providerId, balance_cents: wallet.balance_cents, commission_owed_cents: wallet.commission_owed_cents };
      });
    },
    async getWallet(actor) {
      const who = principal(actor,"provider");
      return database.withTransaction(async tx => {
        await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const wallet = await repo.wallet(tx,who.domainId);
        const transactions=(await repo.providerLedger(tx,who.domainId)).map(publicTransaction);
        if(!wallet) {
          if(transactions.some(row=>["payout_credit","commission_owed"].includes(row.kind))) throw new HttpError(503,"wallet requires reconciliation");
          return {provider_id:who.domainId,balance_cents:null,commission_owed_cents:null,transactions,wallet_setup:"pending"};
        }
        return { provider_id: who.domainId, balance_cents: wallet.balance_cents,
          commission_owed_cents: wallet.commission_owed_cents, transactions };
      });
    },
    async listCustomerTransactions(actor) {
      const who = principal(actor,"customer");
      return (await repo.customerLedger(database,who.domainId)).map(publicTransaction);
    },
    async applyCompletion(input, { client } = {}) {
      const value = context(input);
      const commission = cents(input.commission_cents,"commission");
      if (commission > value.amount_cents || !["gateway","cod"].includes(input.payment_method)) throw new HttpError(400,"invalid completion context");
      const kind = input.payment_method === "gateway" ? "payout_credit" : "commission_owed";
      const amount = kind === "payout_credit" ? value.amount_cents-commission : commission;
      const completion = {...value,commission_cents:commission,payment_method:input.payment_method};
      return write(client,async tx => {
        await repo.lockOrder(tx,value.order_id);
        const ledger = await repo.ledgerForOrder(tx,value.order_id);
        if (ledger.some(row => row.kind === "refund")) throw conflict("refunded booking cannot credit completion");
        const prior = ledger.find(row => ["payout_credit","commission_owed"].includes(row.kind));
        if (prior) {
          if (prior.kind !== kind || !matches(prior,{...value,amount_cents:amount}) || prior.method !== input.payment_method || Object.keys(completion).some(key => prior.context_json[key] !== completion[key])) throw conflict("completion context changed");
          return publicTransaction(prior);
        }
        const intent = await repo.intentByOrder(tx,value.order_id);
        if (input.payment_method === "gateway" && (!intent || !matches(intent,value) || intent.status === "failed")) throw conflict("gateway intent missing, voided or inconsistent");
        if (input.payment_method === "cod" && intent) throw conflict("gateway booking cannot become COD");
        await repo.ensureWallet(tx,value.provider_id);
        await repo.updateWallet(tx,value.provider_id,kind === "payout_credit" ? amount : 0,kind === "commission_owed" ? amount : 0);
        return publicTransaction(await repo.insertTransaction(tx,{...value,kind,amount_cents:amount,method:input.payment_method,context_json:completion}));
      });
    },
    async applyRefund(input, { client } = {}) {
      const value = context(input);
      return write(client,async tx => {
        await repo.lockOrder(tx,value.order_id);
        const ledger = await repo.ledgerForOrder(tx,value.order_id);
        if (ledger.some(row => ["payout_credit","commission_owed"].includes(row.kind))) throw conflict("completed booking requires a different reconciliation flow");
        const charge = ledger.find(row => row.kind === "charge");
        if (!charge || charge.status !== "succeeded" || charge.method !== "gateway" || !matches(charge,value)) throw conflict("refund does not match a settled charge");
        const prior = ledger.find(row => row.kind === "refund");
        if (prior) {
          if (!matches(prior,value)) throw conflict("refund context changed");
          return publicTransaction(prior);
        }
        return publicTransaction(await repo.insertTransaction(tx,{...value,kind:"refund",method:"gateway",status:"refunded"}));
      });
    },
    async simulateSucceeded(orderId, actor) {
      principal(actor,"customer");
      const intent = await operations.getIntentForOrder(orderId,actor);
      const result = await operations.settleWebhook({gateway_event_id:`SIM-EVT-${randomUUID()}`,type:"payment_intent.succeeded",gateway_ref:intent.gateway_ref});
      return {ok:true,...result};
    },
    async settleWebhook(input, { client } = {}) {
      const value = webhook(input);
      // C supplies a local SQL eligibility guard (under the business order lock)
      // and stages payment.succeeded in an outbox using this SAME client.
      if (typeof assertSettlementAllowed !== "function" || typeof stageEvent !== "function") throw new HttpError(503,"payment consistency integration is not configured");
      return write(client,async tx => {
        const initial = await repo.intentByRef(tx,value.gateway_ref);
        if (!initial) throw new HttpError(404,"payment intent not found");
        await repo.lockOrder(tx,initial.order_id);
        const intent = await repo.intentByRef(tx,value.gateway_ref);
        const recorded = await repo.recordWebhook(tx,value);
        if (!recorded.fresh) {
          if (recorded.row.type !== value.type || recorded.row.payload_json.gateway_ref !== value.gateway_ref) throw conflict("gateway event payload changed");
          if (!recorded.row.processed_at) throw conflict("incomplete gateway event requires reconciliation");
          return { replayed: true };
        }
        if (intent.status === "failed") throw conflict("voided intent cannot settle");
        if (intent.status === "succeeded") {
          await repo.markWebhookProcessed(tx,value.gateway_event_id);
          return { replayed:false,already_settled:true };
        }
        if (await assertSettlementAllowed(tx,intent) !== true) throw conflict("booking provisioning is not settleable");
        await repo.setIntentStatus(tx,intent.id,"succeeded");
        await repo.insertTransaction(tx,{order_id:intent.order_id,customer_id:intent.customer_id,provider_id:intent.provider_id,amount_cents:intent.amount_cents,gateway_ref:intent.gateway_ref,kind:"charge",method:"gateway",status:"succeeded"});
        await stageEvent(tx,{ event_type:"payment.succeeded", aggregate_type:"order",aggregate_id:intent.order_id,
          data:{order_id:intent.order_id,customer_id:intent.customer_id,provider_id:intent.provider_id,amount_cents:intent.amount_cents} });
        await repo.markWebhookProcessed(tx,value.gateway_event_id);
        return { replayed:false,settled:true };
      });
    },
  };
  return operations;
}
