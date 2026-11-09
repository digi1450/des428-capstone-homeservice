import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {createApp} from '../src/app.js';import {createPaymentsRuntime} from '../src/runtime.js';import {HttpError} from '../src/errors.js';
import {financialRequest,financialResult} from '../src/financial-validation.js';
const f=JSON.parse(await readFile(new URL('../../../contracts/fixtures/financial-finalization.json',import.meta.url),'utf8'));
const clone=v=>structuredClone(v);
async function setup(t,options={}){
 const calls=[];let result=clone(f.results.completionGatewayReady);
 const operations={complete:async input=>{calls.push(input);return {replayed:false,result};},cancel:async input=>{calls.push(input);return{replayed:false,result};},get:async input=>{calls.push(input);return result;}};
 const verify=async(req,{operation})=>{assert.ok(['complete_financial','cancel_financial','query_financial'].includes(operation));if(req.get('authorization')!=='Bearer booking-fixture')throw new HttpError(401,'fixture rejected');return{service:'booking',callerId:'stable-booking-fixture'};};
 const app=createApp({database:{query:()=>assert.fail('HTTP command must delegate, not perform SQL')},authenticate:()=>assert.fail('callback/internal routes must not use customer verifier'),authenticateService:verify,financialOperations:operations,...options});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
 const base=`http://127.0.0.1:${server.address().port}`;
 return{calls,operations,setResult:v=>{result=clone(v);},request:(path,opts={})=>fetch(base+path,{...opts,headers:{Authorization:'Bearer booking-fixture',...opts.headers}}),post:(path,fixture,headers={})=>fetch(base+path,{method:'POST',headers:{Authorization:'Bearer booking-fixture','Content-Type':'application/json','Idempotency-Key':fixture.command_id,...headers},body:JSON.stringify(fixture.request)})};
}
const complete='/internal/booking-completions',cancel='/internal/booking-cancellations';
test('financial HTTP fails closed for absent verifier/participant and does not reach SQL',async t=>{
 for(const options of [{authenticateService:undefined},{financialOperations:undefined},{financialOperations:{}}]){const p=await setup(t,options);assert.equal((await p.post(complete,f.completeGateway)).status,503);assert.equal(p.calls.length,0);}
 const p=await setup(t);assert.equal((await p.post(complete,f.completeGateway,{Authorization:'Bearer wrong'})).status,401);
 assert.equal((await p.request('/api/payments/webhook',{method:'POST'})).status,503);
});
test('financial request/results conform to fixture identity/arithmetic including COD',()=>{
 for(const [input,outputs] of [['completeGateway',['completionGatewayReady','completionPending','completionAttention']],['completeCod',['completionCodReady','completionCodPending']],['cancelGateway',['cancelVoided','cancelRefunded','cancelGatewayNoPayment','cancelPending','cancelAttention']],['cancelCod',['cancelCodNoPayment','cancelCodPending']]]){
  const kind=input.startsWith('complete')?'completion':'cancellation',v=f[input];
  financialRequest(kind,v.command_id,v.request);for(const output of outputs)financialResult(kind,v.command_id,v.request,f.results[output]);
 }
 const invalid=clone(f.completeGateway.request);invalid.provisioning.create_command_id=17;assert.throws(()=>financialRequest('completion',f.completeGateway.command_id,invalid),e=>e.statusCode===400);
});
test('HTTP maps ready/pending/attention exactly; query 200 still exposes state',async t=>{
 const p=await setup(t);
 for(const [input,output,status] of [['completeGateway','completionGatewayReady',200],['completeCod','completionCodPending',202],['completeGateway','completionAttention',409],['cancelGateway','cancelVoided',200],['cancelGateway','cancelPending',202],['cancelGateway','cancelAttention',409]]){
  p.setResult(f.results[output]);const r=await p.post(input.startsWith('complete')?complete:cancel,f[input]);assert.equal(r.status,status);assert.deepEqual(await r.json(),f.results[output]);
 }
 p.setResult(f.results.cancelAttention);const r=await p.request('/internal/financial-operations/'+f.cancelGateway.command_id);assert.equal(r.status,200);assert.equal((await r.json()).state,'attention');
 p.operations.get=async()=>null;assert.equal((await p.request('/internal/financial-operations/'+f.cancelGateway.command_id)).status,404);
});
test('wrong body/key/query and malformed C outputs cannot return financial success',async t=>{
 const p=await setup(t);
 assert.equal((await p.post(complete,{...f.completeGateway,command_id:f.completeCod.command_id})).status,400);
 assert.equal((await p.post(cancel,f.cancelGateway,{'Idempotency-Key':'../escape'})).status,400);
 assert.equal((await p.post(complete+'?extra=1',f.completeGateway)).status,400);
 p.setResult({...f.results.completionGatewayReady,accounting:{...f.results.completionGatewayReady.accounting,amount_cents:1}});assert.equal((await p.post(complete,f.completeGateway)).status,503);
 p.operations.complete=async input=>{input.request.amount_cents=1;return{replayed:false,result:{...f.results.completionGatewayReady,request:input.request}};};assert.equal((await p.post(complete,f.completeGateway)).status,503);
});
test('typed conflicts serialize only reviewed codes; callback verifier is distinct and precedes parsing',async t=>{
 const p=await setup(t,{authenticateWebhook:async(req,{operation})=>{assert.equal(operation,'settle_webhook');if(req.get('authorization')!=='Bearer gateway-fixture')throw new HttpError(403,'gateway only');return{service:'mock-gateway',callerId:'gateway-fixture'};}});
 for(const code of ['FINANCIAL_COMMAND_CONFLICT','UNKNOWN_CODE']){p.operations.complete=async()=>{const e=new HttpError(409,'fixture conflict');e.code=code;throw e;};const r=await p.post(complete,f.completeGateway);assert.equal(r.status,409);assert.equal((await r.json()).code,code.startsWith('UNKNOWN')?undefined:code);}
 assert.equal((await p.request('/api/payments/webhook',{method:'POST',headers:{'Content-Type':'application/json'},body:'not json'})).status,403);
 assert.equal((await p.request('/api/payments/webhook',{method:'POST',headers:{Authorization:'Bearer gateway-fixture','Content-Type':'application/json'},body:'{"type":"wrong"}'})).status,400);
});
test('financial parsers enforce media and byte bounds and reject incomplete factory composition',async t=>{
 const p=await setup(t);assert.equal((await p.request(complete,{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'})).status,415);
 assert.equal((await p.request(complete,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({large:'x'.repeat(20000)})})).status,413);
 const database={query(){},withTransaction(){}};
 assert.throws(()=>createPaymentsRuntime({database,createFinancialOperations:()=>({complete(){}})}),TypeError);
 assert.throws(()=>createPaymentsRuntime({database,authenticateWebhook:'not-a-function'}),TypeError);
});
