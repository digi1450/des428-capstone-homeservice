// Monolith-owned v1 schemas. Contract package is dev-only, never a runtime import.
import {z} from 'zod';
import {isDeepStrictEqual} from 'node:util';
import {BadRequestError,AppError} from '../../errors.js';
const id=z.number().int().min(1).max(2147483647),money=z.number().int().min(0).max(2147483647);
const uuid=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const command=z.string().regex(/^(complete|cancel):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const key=z.string().regex(/^(?!\.{1,2}$)[A-Za-z0-9._:-]{1,128}$/);
const provisioning=z.object({create_command_id:key,saga_id:key}).strict();
const base={operation_id:uuid,order_id:id,customer_id:id,provider_id:id,amount_cents:money,currency:z.literal('THB')};
const input=kind=>z.union(['gateway','cod'].map(method=>z.object({...base,payment_method:z.literal(method),...(kind==='completion'?{commission_cents:money}:{reason:z.literal('customer_cancelled')}),...(method==='gateway'?{provisioning}:{})}).strict()));
const requests={completion:input('completion'),cancellation:input('cancellation')};
export const webhookInput=z.object({gateway_event_id:z.string().min(1).max(200).refine(v=>!!v.trim()),type:z.literal('payment_intent.succeeded'),gateway_ref:z.string().min(1).max(200).refine(v=>!!v.trim())}).strict();
export const webhookResult=z.union([
 z.object({received:z.literal(true),replayed:z.literal(true)}).strict(),
 z.object({received:z.literal(true),replayed:z.literal(false),settled:z.literal(true)}).strict(),
 z.object({received:z.literal(true),replayed:z.literal(false),already_settled:z.literal(true)}).strict(),
]);
export function financialInput(kind,work){
 if(!requests[kind])throw new BadRequestError('invalid financial operation');
 const r=requests[kind].safeParse(work?.request),k=command.safeParse(work?.commandId);
 if(!r.success||!k.success||k.data!==(kind==='completion'?'complete:':'cancel:')+r.data.operation_id||(kind==='completion'&&r.data.commission_cents>r.data.amount_cents))throw new BadRequestError('invalid financial request');
 return {kind,commandId:k.data,request:r.data};
}
export function financialOutput(expected,value){try{
 const identity={command_id:z.literal(expected.commandId),kind:z.literal(expected.kind),request:requests[expected.kind]};
 const pending=z.object({...identity,state:z.literal('pending'),reason:z.enum(expected.kind==='completion'&&expected.request.payment_method==='gateway'?['processing','awaiting_settlement']:['processing'])}).strict();
 const attention=z.object({...identity,state:z.literal('attention'),reason:z.enum(['context_mismatch','legacy_reconciliation_required','completion_accounted','settlement_contradiction',...(expected.kind==='completion'?['cancellation_fenced']:[])])}).strict();
 let ready;
 if(expected.kind==='completion')ready=z.object({...identity,state:z.literal('ready'),accounting:z.object({transaction_id:id,kind:z.literal(expected.request.payment_method==='gateway'?'payout_credit':'commission_owed'),amount_cents:money}).strict()}).strict();
 else ready=z.union([
  z.object({...identity,state:z.literal('ready'),settlement_fenced:z.literal(true),outcome:z.literal('no_payment')}).strict(),
  ...(expected.request.payment_method==='gateway'?[
   z.object({...identity,state:z.literal('ready'),settlement_fenced:z.literal(true),outcome:z.literal('voided'),voided_intent_id:id}).strict(),
   z.object({...identity,state:z.literal('ready'),settlement_fenced:z.literal(true),outcome:z.literal('refunded'),refund_transaction_id:id}).strict(),
  ]:[]),
 ]);
 const out=z.union([ready,pending,attention]).parse(value);
 if(!isDeepStrictEqual(out.request,expected.request))throw Error('echo');
 if(out.kind==='completion'&&out.state==='ready'&&out.accounting.amount_cents!==(expected.request.payment_method==='gateway'?expected.request.amount_cents-expected.request.commission_cents:expected.request.commission_cents))throw Error('amount');
 return out;
 }catch{throw new AppError(503,'financial result not confirmed');}}
const order={id,customer_id:id,provider_id:id,address_id:id.nullable(),service_date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),starting_time:z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/),ending_time:z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/),duration_min:id,subtotal_cents:money,tax_cents:money,total_cents:money,commission_pct:z.number().min(0).max(100),commission_cents:money.nullable(),provider_earnings_cents:money.nullable(),payment_method:z.enum(['gateway','cod']),payment_status:z.enum(['pending','paid','refunded']),job_request_id:id.nullable(),created_at:z.string().datetime({offset:true}),updated_at:z.string().datetime({offset:true})};
export const completedProjection=z.object({...order,status:z.literal('completed'),payment_status:z.enum(['pending','paid']),commission_cents:money,provider_earnings_cents:money,accounting_status:z.enum(['pending','ready','attention'])}).strict().refine(v=>v.commission_cents<=v.total_cents&&v.provider_earnings_cents===v.total_cents-v.commission_cents);
const pendingOrder=z.object({...order,status:z.enum(['awaiting','confirmed']),payment_status:z.enum(['pending','paid'])}).strict();
export const cancelledProjection=z.union([
 z.object({order:pendingOrder,cancellation_status:z.enum(['pending','attention'])}).strict(),
 z.object({order:z.object({...order,status:z.literal('cancelled')}).strict(),refunded:z.boolean(),cancellation_status:z.literal('ready')}).strict().refine(v=>v.refunded?v.order.payment_method==='gateway'&&v.order.payment_status==='refunded':v.order.payment_status==='pending'),
]);
