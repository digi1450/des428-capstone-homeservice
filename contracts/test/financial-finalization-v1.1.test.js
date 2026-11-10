import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import {spec,validate,assertFinancialRequest,assertFinancialResult} from '../validation/financial-finalization-v1.1.mjs';
import {assertFinancialRequest as assertV1Request} from '../validation/financial-finalization.mjs';
import {assertLegacyManifestContext} from '../validation/legacy-payment-manifest.mjs';
const f=JSON.parse(await readFile(new URL('../fixtures/financial-finalization-v1.1.json',import.meta.url),'utf8'));
const old=JSON.parse(await readFile(new URL('../fixtures/financial-finalization.json',import.meta.url),'utf8'));
const manifest=JSON.parse(await readFile(new URL('../fixtures/legacy-payment-manifest/manifest.json',import.meta.url),'utf8'));
const copy=x=>structuredClone(x);
test('v1.1 is valid standalone OpenAPI and explicitly pending runtime implementation',async()=>{
 await SwaggerParser.validate(fileURLToPath(new URL('../financial-finalization-v1.1.openapi.json',import.meta.url)));
 assert.equal(spec.info.version,'1.1.0');assert.match(spec['x-legacy-binding'].runtimeStatus,/not implemented/);
 for(const [path,item]of Object.entries(spec.paths))if(path.startsWith('/internal/'))for(const op of Object.values(item))assert.equal(op['x-implementation-status'],'v1.1-contract-only-legacy-runtime-pending');
});
test('all provisioning and COD v1 requests/results remain accepted by target v1.1',()=>{
 const operations={};
 for(const name of ['completeGateway','completeCod','cancelGateway','cancelCod']){
  const e={kind:name.startsWith('complete')?'completion':'cancellation',commandId:old[name].command_id,request:old[name].request};operations[e.commandId]=e;assert.doesNotThrow(()=>assertFinancialRequest(e));
 }
 for(const result of Object.values(old.results))assert.doesNotThrow(()=>assertFinancialResult(operations[result.command_id],result));
});
test('legacy completion/cancellation fixtures match manifest and never fabricate provisioning',()=>{
 for(const e of Object.values(f.operations)){
  assert.doesNotThrow(()=>assertFinancialRequest(e));assert.doesNotThrow(()=>assertLegacyManifestContext(e.request,manifest));
  assert.equal(Object.hasOwn(e.request,'provisioning'),false);assert.throws(()=>assertV1Request(e),TypeError,'old v1 remains strict');
 }
 for(const [name,result]of Object.entries(f.results)){
  const operationName=name.replace(/(Ready|Pending|Attention)$/,'');assert.doesNotThrow(()=>assertFinancialResult(f.operations[operationName],result));
 }
});
test('reference forms are mutually exclusive; COD forbids either and gateway requires one',()=>{
 const e=copy(f.operations.completePaid),provisioning=old.completeGateway.request.provisioning;
 for(const request of [{...e.request,provisioning},{...e.request,legacy_binding:undefined},{...old.completeCod.request,legacy_binding:e.request.legacy_binding},{...e.request,otp:123456}])assert.throws(()=>assertFinancialRequest({...e,request}),TypeError);
});
test('embedded order/hash, command UUID and commission bind beyond structural validation',()=>{
 const e=copy(f.operations.completePaid);
 const changes=[x=>x.request.legacy_binding.manifest_sha256='f'.repeat(64),x=>x.request.order_id=13,x=>x.request.legacy_binding.binding_id=x.request.legacy_binding.binding_id.replace(':14',':014'),x=>x.commandId=old.completeGateway.command_id,x=>x.request.commission_cents=x.request.amount_cents+1];
 for(const change of changes){const value=copy(e);change(value);assert.throws(()=>assertFinancialRequest(value),TypeError);}
});
test('results echo exact legacy reference; payout/refund/fence rules remain unchanged',()=>{
 const e=f.operations.completePaid,good=f.results.completePaidReady;
 for(const result of [{...good,request:{...good.request,legacy_binding:f.operations.completeUnpaid.request.legacy_binding}},{...good,accounting:{...good.accounting,amount_cents:1}},{...good,replayed:true}])assert.throws(()=>assertFinancialResult(e,result),TypeError);
 const cancellation=f.operations.cancelUnpaid;
 assert.throws(()=>assertFinancialResult(cancellation,{...f.results.cancelUnpaidReady,settlement_fenced:false}),TypeError);
 const noPayment={...f.results.cancelUnpaidReady,outcome:'no_payment'};delete noPayment.voided_intent_id;
 assert.equal(validate('CancellationOperation',noPayment),false,'approved imported intent absence cannot be ready no_payment');
 assert.throws(()=>assertFinancialResult(cancellation,noPayment),TypeError);
});
test('routes/status/auth/callable names and public projections are unchanged',async()=>{
 const v1=JSON.parse(await readFile(new URL('../financial-finalization.openapi.json',import.meta.url),'utf8'));
 assert.deepEqual(Object.keys(spec.paths),Object.keys(v1.paths));assert.deepEqual(spec.security,v1.security);
 assert.deepEqual(spec['x-c-participant'],v1['x-c-participant']);assert.deepEqual(spec['x-b-authentication'],v1['x-b-authentication']);
 for(const name of ['CompletedOrder','CancellationPublicPending','CancellationPublicAttention','CancellationPublicReady','WebhookRequest','WebhookAck','CodedConflict'])assert.deepEqual(spec.components.schemas[name],v1.components.schemas[name]);
 for(const path of Object.keys(spec.paths))for(const method of Object.keys(spec.paths[path]))assert.deepEqual(spec.paths[path][method].responses,v1.paths[path][method].responses);
});
