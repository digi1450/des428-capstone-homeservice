// Contract conformance reference ONLY. Services/monolith must not import this dev tool at runtime.
// It validates structure and cross-field binding, not auth, DB state, locks or workflow correctness.
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import Ajv from 'ajv';

export const spec = JSON.parse(await readFile(new URL('../financial-finalization.openapi.json',import.meta.url),'utf8'));
const ajv = new Ajv({strict:false});
ajv.addFormat('int32',{type:'number',validate:n=>Number.isInteger(n)&&n>=-2147483648&&n<=2147483647});
ajv.addFormat('date',v=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v);
ajv.addFormat('date-time',v=>/^\d{4}-\d{2}-\d{2}T/.test(v)&&Number.isFinite(Date.parse(v)));
const validators=new Map();
export function validate(name,value){
 if(!Object.hasOwn(spec.components.schemas,name))throw new TypeError('unknown contract schema');
 if(!validators.has(name))validators.set(name,ajv.compile({$ref:'#/components/schemas/'+name,components:spec.components}));
 return validators.get(name)(value);
}
function requireValid(ok){if(!ok)throw new TypeError('invalid financial contract value');}
const nameOf=kind=>kind==='completion'?'Completion':kind==='cancellation'?'Cancellation':null;
export function assertFinancialRequest({kind,commandId,request}){
 const name=nameOf(kind);requireValid(name&&validate(name+'Request',request));
 requireValid(validate('CommandId',commandId));
 requireValid(commandId===(kind==='completion'?'complete:':'cancel:')+request.operation_id);
 if(kind==='completion')requireValid(request.commission_cents<=request.amount_cents);
 return request;
}
export function assertFinancialResult(expected,result){
 assertFinancialRequest(expected);
 requireValid(validate(nameOf(expected.kind)+'Operation',result));
 requireValid(result.kind===expected.kind&&result.command_id===expected.commandId&&isDeepStrictEqual(result.request,expected.request));
 if(result.state==='pending'&&result.reason==='awaiting_settlement')requireValid(expected.kind==='completion'&&expected.request.payment_method==='gateway');
 if(result.state==='ready'&&result.kind==='completion'){
  const request=expected.request;
  requireValid(result.accounting.amount_cents===(request.payment_method==='gateway'?request.amount_cents-request.commission_cents:request.commission_cents));
 }
 return result;
}
export function assertPublicFinancialResult(kind,value){
 if(kind==='completion'){
  requireValid(validate('CompletedOrder',value));
  requireValid(value.commission_cents<=value.total_cents&&value.provider_earnings_cents===value.total_cents-value.commission_cents);
 }else{
  requireValid(kind==='cancellation'&&['CancellationPublicPending','CancellationPublicAttention','CancellationPublicReady'].some(name=>validate(name,value)));
  if(value.cancellation_status==='ready'){
   requireValid(value.refunded===true
    ?value.order.payment_method==='gateway'&&value.order.payment_status==='refunded'
    :value.order.payment_status==='pending');
  }
 }
 return value;
}
