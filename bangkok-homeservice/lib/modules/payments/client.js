// Prepared transport only. Existing routes/pages/Booking still use local services.
// C owns durable command identity/results/fences; D owns retry policy. This client
// NEVER generates a command key, retries automatically, releases slots or uses SQL.
import { z } from "zod";
import { AppError, BadRequestError, UnauthorizedError } from "../../errors.js";

const id = z.number().int().positive().max(2147483647);
const money = z.number().int().nonnegative().max(2147483647);
const key = z.string().regex(/^(?!\.{1,2}$)[A-Za-z0-9._:-]{1,128}$/);
const intent = z.object({ id, order_id:id, amount_cents:money, gateway_ref:z.string().min(1),
  status:z.enum(["requires_payment","succeeded","failed"]) }).strict();
const transaction = z.object({ id,order_id:id.nullable(),kind:z.enum(["charge","payout_credit","commission_owed","refund"]),
  amount_cents:money,method:z.enum(["cod","gateway"]),gateway_ref:z.string().nullable(),
  status:z.enum(["pending","succeeded","failed","refunded"]),created_at:z.string().datetime({offset:true}) }).strict();
const wallet = z.object({provider_id:id,balance_cents:money,commission_owed_cents:money,transactions:z.array(transaction)}).strict();
const createInput = z.object({order_id:id,customer_id:id,provider_id:id,amount_cents:money,currency:z.literal("THB"),saga_id:key}).strict();
const operationIdentity = z.object({create_command_id:key,saga_id:key}).strict();
const lookupInput = operationIdentity.extend({order_id:id,amount_cents:money}).strict();
const cancelInput = operationIdentity.extend({reason:z.enum(["booking_setup_failed","booking_finalization_failed"])}).strict();
const created = z.object({create_command_id:key,saga_id:key,outcome:z.literal("created"),payment_intent:intent}).strict();
const cancelled = z.object({create_command_id:key,saga_id:key,outcome:z.literal("cancelled")}).strict();
const activated = operationIdentity.extend({outcome:z.literal("activated")}).strict();
const activationError = z.object({error:z.string(),requestId:z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/)}).strict();
const activationConflict = z.union([activationError.extend({code:z.literal("PAYMENT_SETUP_CANCELLED")}).strict(),activationError]);
const operationResult = z.discriminatedUnion("outcome",[created,cancelled]);

function parse(schema, value, label) {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestError(`invalid payment ${label}`);
  return result.data;
}

// For create/query/cancel, a 404/timeout/409 is not a safe cancellation, even after a retry.
// Activation has a separate strictly validated coded/uncoded 409 contract below.
// C retains its durable operation and reconciles using the SAME identifiers.
export class PaymentOutcomeUnknownError extends AppError {
  constructor(operation,createCommandId,reason,upstreamStatus) {
    super(503,"payment operation outcome is not confirmed");
    this.name="PaymentOutcomeUnknownError";
    this.outcomeUnknown=true;
    this.operation=operation;
    this.createCommandId=createCommandId;
    this.reason=reason;
    if (upstreamStatus !== undefined) this.upstreamStatus=upstreamStatus;
  }
}

// Activation-only terminal errors. Existing create/query/cancel errors stay UNKNOWN.
export class PaymentSetupCancelledError extends AppError {
  constructor(createCommandId,commandId,sagaId) {
    super(409,"payment setup was cancelled");
    this.name="PaymentSetupCancelledError";
    this.code="PAYMENT_SETUP_CANCELLED";
    this.operation="activate";
    this.createCommandId=createCommandId; this.commandId=commandId; this.sagaId=sagaId;
  }
}
export class PaymentActivationConflictError extends AppError {
  constructor(createCommandId,commandId,sagaId) {
    super(409,"payment activation requires reconciliation");
    this.name="PaymentActivationConflictError";
    this.reconciliationRequired=true;
    this.operation="activate";
    this.createCommandId=createCommandId; this.commandId=commandId; this.sagaId=sagaId;
  }
}
// Bound decoded error data before parsing. A malformed/oversized 409 is not a verified conflict.
async function readActivationConflict(response) {
  if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase()!=="application/json" || !response.body) throw new Error("invalid conflict response");
  const reader=response.body.getReader(), chunks=[];
  let size=0;
  try {
    for (;;) {
      const {done,value}=await reader.read(); if(done) break;
      size+=value.byteLength;
      if(size>16384) { await reader.cancel(); throw new Error("conflict response too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return activationConflict.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

export function createPaymentsClient({baseUrl,timeoutMs=2000,fetchImpl=fetch}) {
  let base;
  try { base=new URL(baseUrl); } catch { throw new Error("Invalid Payments base URL"); }
  if (!["http:","https:"].includes(base.protocol) || base.username || base.password || base.pathname!=="/" || base.search || base.hash) throw new Error("Payments base URL must be an HTTP origin");
  if (!Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>60000) throw new Error("Invalid Payments timeout");

  async function request({path,method="GET",credentials,body,schema,statuses=[200],command,commandId}) {
    if (typeof credentials?.token!=="string" || !credentials.token.trim() || /[\r\n]/.test(credentials.token)) throw new UnauthorizedError("missing bearer token");
    const headers={Authorization:`Bearer ${credentials.token}`};
    for (const [property,header] of [["requestId","X-Request-Id"],["traceparent","traceparent"],["tracestate","tracestate"]]) {
      const value=credentials[property];
      if (value!==undefined) {
        const valid=typeof value==="string" && (property==="requestId" ? /^[A-Za-z0-9._:-]{1,128}$/.test(value) : /^[\x20-\x7e]{1,512}$/.test(value));
        if (!valid) throw new BadRequestError("invalid payment request metadata");
        headers[header]=value;
      }
    }
    if (commandId!==undefined) headers["Idempotency-Key"]=commandId;
    if (body!==undefined) headers["Content-Type"]="application/json";
    const failure=(reason,status)=>command
      ? new PaymentOutcomeUnknownError(command.operation,command.createCommandId,reason,status)
      : new AppError(503,"payments service unavailable");
    let response;
    try {
      response=await fetchImpl(new URL(path,base),{method,headers,body:body===undefined?undefined:JSON.stringify(body),
        redirect:"error",signal:AbortSignal.timeout(timeoutMs)});
    } catch { throw failure("transport_unavailable"); }
    if (!statuses.includes(response.status)) {
      if (command?.operation === "activate" && response.status === 409) {
        let conflict;
        try { conflict=await readActivationConflict(response); }
        catch {
          // Do not expose upstreamStatus=409 for an unvalidated body: C must keep it pending.
          throw failure("invalid_response");
        }
        throw conflict.code === "PAYMENT_SETUP_CANCELLED"
          ? new PaymentSetupCancelledError(command.createCommandId,commandId,body.saga_id)
          : new PaymentActivationConflictError(command.createCommandId,commandId,body.saga_id);
      }
      try { await response.body?.cancel(); } catch { /* preserve outcome classification */ }
      if (command) throw failure(command.operation==="query" && response.status===404 ? "lookup_missing" : "unexpected_status",response.status);
      const known={400:"invalid payment request",401:"invalid payments credentials",403:"payments access forbidden",404:"payment resource not found"};
      if (known[response.status]) throw new AppError(response.status,known[response.status]);
      throw failure("unexpected_status");
    }
    try {
      if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase()!=="application/json") {
        await response.body?.cancel();
        throw failure("invalid_response");
      }
      const result=schema.safeParse(await response.json());
      if (!result.success) throw failure("invalid_response");
      return result.data;
    } catch { throw failure("invalid_response"); }
  }

  function checkOutcome(result,flow,{orderId,amountCents}={}) {
    const wrong=result.create_command_id!==flow.create_command_id || result.saga_id!==flow.saga_id ||
      (result.outcome==="created" && (result.payment_intent.status==="failed" ||
        (orderId!==undefined && result.payment_intent.order_id!==orderId) ||
        (amountCents!==undefined && result.payment_intent.amount_cents!==amountCents)));
    if (wrong) throw new PaymentOutcomeUnknownError(flow.operation,flow.create_command_id,"mismatched_response");
    return result;
  }
  return {
    getWallet: credentials=>request({path:"/api/provider/wallet",credentials,schema:wallet}),
    listCustomerTransactions: credentials=>request({path:"/api/customer/transactions",credentials,schema:z.array(transaction)}),
    async createIntent(input,credentials) {
      const body=parse(createInput,input,"intent context");
      const commandId=parse(key,credentials?.commandId,"create command ID");
      const flow={create_command_id:commandId,saga_id:body.saga_id,operation:"create"};
      const result=await request({path:"/internal/payment-intents",method:"POST",body,credentials,commandId,schema:created,statuses:[200,201],command:{operation:"create",createCommandId:commandId}});
      return checkOutcome(result,flow,{orderId:body.order_id,amountCents:body.amount_cents});
    },
    async getOperation(input,credentials) {
      const lookup=parse(lookupInput,input,"operation lookup");
      const result=await request({path:`/internal/payment-operations/${encodeURIComponent(lookup.create_command_id)}`,credentials,schema:operationResult,command:{operation:"query",createCommandId:lookup.create_command_id}});
      return checkOutcome(result,{...lookup,operation:"query"},{orderId:lookup.order_id,amountCents:lookup.amount_cents});
    },
    async activateIntent(input,credentials) {
      const body=parse(operationIdentity,input,"activation context");
      const commandId=parse(key,credentials?.commandId,"activate command ID");
      if (commandId===body.create_command_id) throw new BadRequestError("create and activate command IDs must differ");
      const result=await request({path:"/internal/payment-intents/activate-by-command",method:"POST",body,credentials,commandId,schema:activated,command:{operation:"activate",createCommandId:body.create_command_id}});
      return checkOutcome(result,{...body,operation:"activate"});
    },
    async cancelIntent(input,credentials) {
      const body=parse(cancelInput,input,"cancellation context");
      const commandId=parse(key,credentials?.commandId,"cancel command ID");
      if (commandId===body.create_command_id) throw new BadRequestError("create and cancel command IDs must differ");
      const result=await request({path:"/internal/payment-intents/cancel-by-command",method:"POST",body,credentials,commandId,schema:cancelled,command:{operation:"cancel",createCommandId:body.create_command_id}});
      return checkOutcome(result,{...body,operation:"cancel"});
    },
  };
}
