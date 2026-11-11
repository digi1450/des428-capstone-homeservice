import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {financialInput,financialOutput} from '../lib/modules/payments/financial-validation.js';
import {financialRequest,financialResult} from '../../services/payments-wallet/src/financial-validation.js';
const vectors=JSON.parse(await readFile(new URL('../../contracts/fixtures/financial-finalization-v1.1.json',import.meta.url),'utf8'));
const validate=work=>{
 assert.deepEqual(financialInput(work.kind,work).request,work.request);
 assert.deepEqual(financialRequest(work.kind,work.commandId,work.request),work.request);
};
test('both runtime validators accept all v1.1 reference fixtures and immutable result echoes',()=>{
 for(const work of Object.values(vectors.operations))validate(work);
 for(const result of Object.values(vectors.results)){
  const expected={kind:result.kind,commandId:result.command_id,request:result.request};
  assert.deepEqual(financialOutput(expected,result),result);
  assert.deepEqual(financialResult(result.kind,result.command_id,result.request,result),result);
 }
});
test('both validators reject malformed/dual/COD references and impossible legacy no-payment result',()=>{
 const original=vectors.operations.cancelUnpaid;
 for(const mutate of [r=>{r.provisioning={create_command_id:'create:test',saga_id:'saga:test'};},r=>{delete r.legacy_binding;},r=>{r.legacy_binding.manifest_sha256='a'.repeat(64);},r=>{r.order_id++;},r=>{r.legacy_binding.extra=true;},r=>{r.payment_method='cod';}]){
  const work=structuredClone(original);mutate(work.request);
  assert.throws(()=>financialInput(work.kind,work));assert.throws(()=>financialRequest(work.kind,work.commandId,work.request));
 }
 const result={command_id:original.commandId,kind:original.kind,request:original.request,state:'ready',settlement_fenced:true,outcome:'no_payment'};
 assert.throws(()=>financialOutput(original,result));assert.throws(()=>financialResult(original.kind,original.commandId,original.request,result));
 const changed=structuredClone(vectors.results.cancelUnpaidReady);changed.request.amount_cents++;
 assert.throws(()=>financialOutput(original,changed));assert.throws(()=>financialResult(original.kind,original.commandId,original.request,changed));
});
