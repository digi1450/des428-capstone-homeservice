import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import {spec,validate,assertFinancialRequest,assertFinancialResult,assertPublicFinancialResult} from '../validation/financial-finalization.mjs';
const f=JSON.parse(await readFile(new URL('../fixtures/financial-finalization.json',import.meta.url),'utf8'));
const copy=value=>structuredClone(value);
const expected=(key)=>({kind:key.startsWith('complete')?'completion':'cancellation',commandId:f[key].command_id,request:copy(f[key].request)});

test('financial finalization OpenAPI validates and marks all new behavior unimplemented',async()=>{
 await SwaggerParser.validate(fileURLToPath(new URL('../financial-finalization.openapi.json',import.meta.url)));
 for(const [path,item] of Object.entries(spec.paths)){
  for(const operation of Object.values(item))assert.match(operation['x-implementation-status'],/not-(mounted|implemented)$/);
  if(path.startsWith('/internal/'))assert.deepEqual(spec.security,[{serviceBearer:[]}]);
 }
 assert.equal(spec.info.version,'1.0.0');
});
test('gateway/COD requests bind durable command identity without fabricated COD provisioning',()=>{
 for(const key of ['completeGateway','completeCod','cancelGateway','cancelCod'])assert.doesNotThrow(()=>assertFinancialRequest(expected(key)));
 assert.equal(Object.hasOwn(f.completeCod.request,'provisioning'),false);
 assert.equal(Object.hasOwn(f.cancelCod.request,'provisioning'),false);
 assert.notEqual(f.completeGateway.command_id,f.cancelGateway.command_id);
});
test('request schemas reject private/untrusted fields, wrong type/range and wrong provisioning method',()=>{
 const e=expected('completeGateway');
 for(const request of [{...e.request,otp:123456},{...e.request,raw_role:'admin'},{...e.request,customer_id:'7'},
  {...e.request,amount_cents:-1},{...e.request,amount_cents:2147483648},{...e.request,currency:'USD'},
  {...e.request,operation_id:'..'},{...e.request,provisioning:{create_command_id:'..',saga_id:'s'}}]){
  assert.throws(()=>assertFinancialRequest({...e,request}),TypeError);
 }
 const cod={...f.completeCod.request,provisioning:f.completeGateway.request.provisioning};
 assert.equal(validate('CompletionRequest',cod),false);
 const missing=copy(f.cancelGateway.request);delete missing.provisioning;assert.equal(validate('CancellationRequest',missing),false);
 assert.equal(validate('CancellationRequest',{...f.cancelCod.request,reason:'admin_override'}),false);
});
test('cross-field request checks reject changed command UUID/kind and impossible commission',()=>{
 const e=expected('completeGateway');
 for(const commandId of [f.completeCod.command_id,f.cancelGateway.command_id,'../escape','complete:not-a-uuid'])assert.throws(()=>assertFinancialRequest({...e,commandId}),TypeError);
 assert.throws(()=>assertFinancialRequest({...e,request:{...e.request,commission_cents:e.request.amount_cents+1}}),TypeError);
 // Different property order is the same immutable snapshot, not a changed request.
 assert.doesNotThrow(()=>assertFinancialRequest({...e,request:Object.fromEntries(Object.entries(e.request).reverse())}));
});
test('all completion results match the echoed request and gateway/COD accounting arithmetic',()=>{
 for(const key of ['completionGatewayReady','completionPending','completionAttention'])assert.doesNotThrow(()=>assertFinancialResult(expected('completeGateway'),f.results[key]));
 for(const key of ['completionCodReady','completionCodPending'])assert.doesNotThrow(()=>assertFinancialResult(expected('completeCod'),f.results[key]));
 const zero=expected('completeCod');zero.request.amount_cents=0;zero.request.commission_cents=0;
 assert.doesNotThrow(()=>assertFinancialResult(zero,{...f.results.completionCodReady,request:zero.request,accounting:{...f.results.completionCodReady.accounting,amount_cents:0}}));
});
test('ready cannot be inferred from wrong context, stale command, wrong ledger kind or money',()=>{
 const e=expected('completeGateway'),good=f.results.completionGatewayReady;
 for(const result of [{...good,command_id:f.completeCod.command_id},{...good,request:{...good.request,order_id:999}},
  {...good,request:{...good.request,provider_id:999}}, {...good,accounting:{...good.accounting,amount_cents:10700}},
  {...good,accounting:{...good.accounting,kind:'commission_owed'}},{...good,replayed:true}])assert.throws(()=>assertFinancialResult(e,result),TypeError);
 const cod=expected('completeCod');assert.throws(()=>assertFinancialResult(cod,{...f.results.completionCodPending,reason:'awaiting_settlement'}),TypeError);
 assert.doesNotThrow(()=>assertFinancialResult(e,{...good,request:Object.fromEntries(Object.entries(good.request).reverse())}));
});
test('cancellation ready requires an explicit fence and exactly the applicable no-payment/void/refund evidence',()=>{
 for(const key of ['cancelGatewayNoPayment','cancelVoided','cancelRefunded','cancelPending','cancelAttention'])assert.doesNotThrow(()=>assertFinancialResult(expected('cancelGateway'),f.results[key]));
 for(const key of ['cancelCodNoPayment','cancelCodPending'])assert.doesNotThrow(()=>assertFinancialResult(expected('cancelCod'),f.results[key]));
 for(const result of [{...f.results.cancelVoided,settlement_fenced:false},
  {...f.results.cancelRefunded,refund_transaction_id:undefined},
  {...f.results.cancelPending,refunded:true},{...f.results.cancelPending,settlement_fenced:true},
  {...f.results.cancelAttention,reason:'ignore_and_succeed'}])assert.throws(()=>assertFinancialResult(expected('cancelGateway'),result),TypeError);
 assert.equal(validate('CancellationOperation',{...f.results.cancelRefunded,command_id:f.cancelCod.command_id,request:f.cancelCod.request}),false);
});
test('HTTP status separates durable ready, pending, attention and unknown lookup',()=>{
 for(const [path,prefix] of [['/internal/booking-completions','Completion'],['/internal/booking-cancellations','Cancellation']]){
  const op=spec.paths[path].post;
  assert.equal(op.responses['200'].content['application/json'].schema.$ref,'#/components/schemas/'+prefix+'Ready');
  assert.equal(op.responses['202'].content['application/json'].schema.$ref,'#/components/schemas/'+prefix+'Pending');
  for(const code of ['400','401','403','409','413','415','500','503'])assert.ok(op.responses[code]);
  assert.equal(op.parameters[0].name,'Idempotency-Key');assert.equal(op.parameters[0].required,true);
 }
 const query=spec.paths['/internal/financial-operations/{command_id}'].get;
 assert.equal(query.responses['200'].content['application/json'].schema.$ref,'#/components/schemas/FinancialOperation');
 assert.match(query.responses['404'].description,/Unknown/);
 assert.equal(validate('FinancialOperation',{ok:true}),false);
 for(const conflict of f.conflicts)assert.equal(validate('CodedConflict',conflict),true);
 assert.equal(validate('CodedConflict',{...f.conflicts[0],code:'UNKNOWN_CODE'}),false);
 assert.equal(validate('Error',f.error),true);
});
test('webhook is a distinct mock-gateway boundary, not a Booking/customer token fallback',()=>{
 const op=spec.paths['/api/payments/webhook'].post;
 assert.deepEqual(op.security,[{gatewayBearer:[]}]);
 assert.equal(op['x-required-operation'],'settle_webhook');
 assert.equal(validate('WebhookRequest',f.webhook),true);
 for(const value of [{...f.webhook,type:'anything'},{...f.webhook,gateway_event_id:' '},{...f.webhook,customer_id:7}])assert.equal(validate('WebhookRequest',value),false);
 for(const ack of f.webhookAcks)assert.equal(validate('WebhookAck',ack),true);
 assert.equal(validate('WebhookAck',{received:true,replayed:false,settled:true,already_settled:true}),false);
 assert.equal(validate('WebhookAck',{received:true}),false);
});
test('public completion and cancellation projections cannot fabricate final cancellation/refund',()=>{
 for(const name of ['completedPending','completedReady','completedAttention'])assert.doesNotThrow(()=>assertPublicFinancialResult('completion',f.public[name]));
 for(const name of ['cancelPending','cancelAttention','cancelRefunded','cancelVoided'])assert.doesNotThrow(()=>assertPublicFinancialResult('cancellation',f.public[name]));
 for(const value of [{...f.public.cancelPending,refunded:false},{...f.public.cancelPending,order:{...f.public.cancelPending.order,status:'cancelled'}},
  {...f.public.cancelRefunded,refunded:false},{...f.public.cancelVoided,refunded:true},
  {...f.public.cancelRefunded,order:{...f.public.cancelRefunded.order,payment_method:'cod'}}])assert.throws(()=>assertPublicFinancialResult('cancellation',value),TypeError);
 assert.throws(()=>assertPublicFinancialResult('completion',{...f.public.completedReady,provider_earnings_cents:10700}),TypeError);
 assert.equal(validate('CompletePublicRequest',{otp:123456}),true);
 assert.equal(validate('CompletePublicRequest',{otp:123456,amount_cents:10700}),false);
 assert.equal(validate('EmptyCancellationRequest',{}),true);
 assert.equal(validate('EmptyCancellationRequest',{order_id:42}),false);
});
