// Service-owned v1 validation. No runtime import from the contracts/dev package.
import {isDeepStrictEqual} from 'node:util';
import {HttpError} from './errors.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const key=/^(?!\.{1,2}$)[A-Za-z0-9._:-]{1,128}$/;
const yes=ok=>{if(!ok)throw new Error('contract');};
const id=n=>Number.isInteger(n)&&n>0&&n<=2147483647;
const money=n=>Number.isInteger(n)&&n>=0&&n<=2147483647;
function object(v,fields){yes(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===fields.length&&fields.every(k=>Object.hasOwn(v,k)));}
function request(kind,commandId,v){
 yes(['completion','cancellation'].includes(kind));
 const fields=['operation_id','order_id','customer_id','provider_id','amount_cents','currency','payment_method',kind==='completion'?'commission_cents':'reason'];
 if(v?.payment_method==='gateway')fields.push('provisioning');
 object(v,fields);yes(uuid.test(v.operation_id)&&commandId===(kind==='completion'?'complete:':'cancel:')+v.operation_id);
 yes(id(v.order_id)&&id(v.customer_id)&&id(v.provider_id)&&money(v.amount_cents)&&v.currency==='THB'&&['gateway','cod'].includes(v.payment_method));
 if(kind==='completion')yes(money(v.commission_cents)&&v.commission_cents<=v.amount_cents);else yes(v.reason==='customer_cancelled');
 if(v.payment_method==='gateway'){object(v.provisioning,['create_command_id','saga_id']);yes(typeof v.provisioning.create_command_id==='string'&&typeof v.provisioning.saga_id==='string'&&key.test(v.provisioning.create_command_id)&&key.test(v.provisioning.saga_id));}
 return structuredClone(v);
}
export function financialRequest(kind,commandId,value){try{return request(kind,commandId,value);}catch{throw new HttpError(400,'invalid financial command');}}
export function financialKey(value){
 if(typeof value!=='string'||!/^(complete|cancel):/.test(value)||!uuid.test(value.slice(value.indexOf(':')+1)))throw new HttpError(400,'invalid financial command identity');
 return value;
}
export function financialResult(kind,commandId,expected,value){try{
 const fields=['command_id','kind','request','state'];
 if(value?.state==='ready'){
  if(kind==='completion')fields.push('accounting');
  else {fields.push('settlement_fenced','outcome');if(value.outcome==='voided')fields.push('voided_intent_id');if(value.outcome==='refunded')fields.push('refund_transaction_id');}
 }else fields.push('reason');
 object(value,fields);yes(value.command_id===commandId&&value.kind===kind);
 const echoed=request(kind,commandId,value.request);yes(isDeepStrictEqual(echoed,expected));
 if(value.state==='pending')yes(value.reason==='processing'||(kind==='completion'&&expected.payment_method==='gateway'&&value.reason==='awaiting_settlement'));
 else if(value.state==='attention')yes(['context_mismatch','legacy_reconciliation_required','completion_accounted','settlement_contradiction',...(kind==='completion'?['cancellation_fenced']:[])].includes(value.reason));
 else {yes(value.state==='ready');if(kind==='completion'){
  object(value.accounting,['transaction_id','kind','amount_cents']);yes(id(value.accounting.transaction_id));
  yes(value.accounting.kind===(expected.payment_method==='gateway'?'payout_credit':'commission_owed'));
  yes(value.accounting.amount_cents===(expected.payment_method==='gateway'?expected.amount_cents-expected.commission_cents:expected.commission_cents));
 }else{
  yes(value.settlement_fenced===true&&['no_payment','voided','refunded'].includes(value.outcome));
  if(expected.payment_method==='cod')yes(value.outcome==='no_payment');
  if(value.outcome==='voided')yes(id(value.voided_intent_id));if(value.outcome==='refunded')yes(id(value.refund_transaction_id));
 }}return structuredClone(value);
 }catch{throw new HttpError(503,'financial result not confirmed');}}
export function webhookRequest(v){try{object(v,['gateway_event_id','type','gateway_ref']);yes(v.type==='payment_intent.succeeded');for(const k of ['gateway_event_id','gateway_ref'])yes(typeof v[k]==='string'&&v[k].trim().length&&v[k].length<=200);return {...v};}catch{throw new HttpError(400,'invalid webhook');}}
export function webhookAck(v){try{
 yes(v?.received===true&&typeof v.replayed==='boolean');
 object(v,v.replayed?['received','replayed']:v.settled===true?['received','replayed','settled']:['received','replayed','already_settled']);
 yes(v.replayed||v.settled===true||v.already_settled===true);return {...v};
 }catch{throw new HttpError(503,'webhook result not confirmed');}}
