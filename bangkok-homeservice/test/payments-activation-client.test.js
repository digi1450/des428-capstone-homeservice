import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createPaymentsClient,PaymentOutcomeUnknownError,PaymentSetupCancelledError,PaymentActivationConflictError} from '../lib/modules/payments/client.js';
import {createBookingPaymentsAdapter} from '../lib/modules/booking/payment-adapter.js';
const body={create_command_id:'create:saga-42',saga_id:'saga-42'};
const workflow={createCommandId:body.create_command_id,sagaId:body.saga_id,activateCommandId:'activate:saga-42'};
const result={...body,outcome:'activated'};
const credentials={token:'activation-fixture',requestId:'activation-client',traceparent:'00-11111111111111111111111111111111-2222222222222222-01'};
const coded={error:'private upstream message',requestId:'upstream-probe',code:'PAYMENT_SETUP_CANCELLED'};
async function serve(t,handler){
 const server=http.createServer((req,res)=>Promise.resolve(handler(req,res)).catch(()=>{res.statusCode=500;res.end();})).listen(0,'127.0.0.1');
 await new Promise(resolve=>server.once('listening',resolve));
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 return `http://127.0.0.1:${server.address().port}`;
}
const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
async function read(req){let text='';for await(const chunk of req)text+=chunk;return JSON.parse(text);}
const unknown=error=>error instanceof PaymentOutcomeUnknownError&&error.operation==='activate'&&error.createCommandId===body.create_command_id&&error.outcomeUnknown===true;

test('activation adapter and actual transport preserve stable key/body and safe metadata on explicit replay',async t=>{
 const calls=[];const url=await serve(t,async(req,res)=>{calls.push({path:req.url,method:req.method,key:req.headers['idempotency-key'],request:await read(req),authorization:req.headers.authorization,trace:req.headers.traceparent});send(res,200,result);});
 const adapter=createBookingPaymentsAdapter({paymentsClient:createPaymentsClient({baseUrl:url})});
 const before=structuredClone({workflow,credentials});
 assert.deepEqual(await adapter.activate(workflow,credentials),result);
 assert.deepEqual(await adapter.activate(workflow,credentials),result);
 assert.deepEqual({workflow,credentials},before);assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);
 assert.equal(calls[0].path,'/internal/payment-intents/activate-by-command');assert.equal(calls[0].method,'POST');
 assert.equal(calls[0].key,workflow.activateCommandId);assert.deepEqual(calls[0].request,body);
 assert.equal(calls[0].authorization,'Bearer activation-fixture');assert.equal(calls[0].trace,credentials.traceparent);
});
test('lost activation reply is unknown and only an explicit retry sends the same command again',async t=>{
 const calls=[];const url=await serve(t,async(req,res)=>{calls.push({key:req.headers['idempotency-key'],body:await read(req)});if(calls.length===1)res.destroy();else send(res,200,result);});
 const adapter=createBookingPaymentsAdapter({paymentsClient:createPaymentsClient({baseUrl:url})});
 await assert.rejects(adapter.activate(workflow,credentials),unknown);assert.equal(calls.length,1);
 assert.deepEqual(await adapter.activate(workflow,credentials),result);assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);
});
test('verified coded 409 and uncoded 409 produce distinct sanitized activation errors',async t=>{
 const url=await serve(t,(_req,res)=>send(res,409,coded));
 const adapter=createBookingPaymentsAdapter({paymentsClient:createPaymentsClient({baseUrl:url})});
 await assert.rejects(adapter.activate(workflow,credentials),error=>{
  assert.ok(error instanceof PaymentSetupCancelledError);assert.equal(error.statusCode,409);assert.equal(error.code,'PAYMENT_SETUP_CANCELLED');
  assert.equal(error.createCommandId,workflow.createCommandId);assert.equal(error.commandId,workflow.activateCommandId);assert.equal(error.sagaId,workflow.sagaId);
  assert.ok(!JSON.stringify(error).includes('private'));assert.ok(!JSON.stringify(error).includes(credentials.token));return true;
 });
 const plain=await serve(t,(_req,res)=>send(res,409,{error:'private upstream message',requestId:'upstream-probe'}));
 await assert.rejects(createPaymentsClient({baseUrl:plain}).activateIntent(body,{...credentials,commandId:workflow.activateCommandId}),error=>error instanceof PaymentActivationConflictError&&error.statusCode===409&&error.code===undefined&&error.reconciliationRequired===true&&!JSON.stringify(error).includes('private'));
});
test('a cancellation code on any non-409 status cannot establish a fence',async t=>{
 for(const status of [400,401,403,404,429,500,503]){
  const url=await serve(t,(_req,res)=>send(res,status,coded));
  await assert.rejects(createPaymentsClient({baseUrl:url}).activateIntent(body,{...credentials,commandId:workflow.activateCommandId}),error=>unknown(error)&&error.code===undefined&&error.upstreamStatus===status);
 }
});
test('invalid, oversized or private 409 bodies remain unknown without a confirmed conflict status',async t=>{
 for(const [type,payload] of [['text/html',JSON.stringify(coded)],['application/json','{'],['application/json',JSON.stringify({...coded,extra:'private'})],['application/json',JSON.stringify({...coded,code:'UNREVIEWED'})],['application/json',JSON.stringify({...coded,requestId:'bad id'})],['application/json',JSON.stringify({...coded,error:'x'.repeat(17000)})]]){
  const url=await serve(t,(_req,res)=>{res.writeHead(409,{'Content-Type':type});res.end(payload);});
  await assert.rejects(createPaymentsClient({baseUrl:url}).activateIntent(body,{...credentials,commandId:workflow.activateCommandId}),error=>unknown(error)&&error.code===undefined&&error.upstreamStatus===undefined&&error.reason==='invalid_response');
 }
});
test('stalled activation conflict body obeys the deadline and stays unknown', {timeout:3000},async t=>{
 let calls=0;const url=await serve(t,(_req,res)=>{calls++;res.writeHead(409,{'Content-Type':'application/json'});res.flushHeaders();});
 await assert.rejects(createPaymentsClient({baseUrl:url,timeoutMs:50}).activateIntent(body,{...credentials,commandId:workflow.activateCommandId}),error=>unknown(error)&&error.upstreamStatus===undefined);
 assert.equal(calls,1);
});
test('wrong command/saga/outcome and unexpected success status cannot confirm readiness',async t=>{
 for(const [status,value] of [[200,{...result,create_command_id:'other'}],[200,{...result,saga_id:'other'}],[200,{...result,outcome:'cancelled'}],[200,{...result,private:true}],[201,result],[202,result]]){
  const url=await serve(t,(_req,res)=>send(res,status,value));
  await assert.rejects(createPaymentsClient({baseUrl:url}).activateIntent(body,{...credentials,commandId:workflow.activateCommandId}),unknown);
 }
});
test('invalid activation workflow, conflicting supplied key and missing credentials fail before HTTP',async()=>{
 let calls=0;const client=createPaymentsClient({baseUrl:'http://localhost:3002',fetchImpl:async()=>{calls++;assert.fail();}});
 const adapter=createBookingPaymentsAdapter({paymentsClient:client});
 for(const key of [undefined,'','.', '..','bad key','x'.repeat(129),body.create_command_id]) await assert.rejects(client.activateIntent(body,{...credentials,commandId:key}),error=>error.statusCode===400);
 await assert.rejects(client.activateIntent({...body,extra:true},{...credentials,commandId:workflow.activateCommandId}),error=>error.statusCode===400);
 for(const invalid of [{...workflow,activateCommandId:workflow.createCommandId},{...workflow,sagaId:'..'},{...workflow,extra:true}]) assert.throws(()=>adapter.activate(invalid,credentials),error=>error.statusCode===400);
 assert.throws(()=>adapter.activate(workflow,{...credentials,commandId:'conflicting'}),error=>error.statusCode===400);
 await assert.rejects(adapter.activate(workflow,{}),error=>error.statusCode===401);assert.equal(calls,0);
});
test('new coded error parsing does not change create/cancel outcome-unknown behavior',async t=>{
 const url=await serve(t,(_req,res)=>send(res,409,coded));const client=createPaymentsClient({baseUrl:url});
 await assert.rejects(client.createIntent({order_id:42,customer_id:7,provider_id:3,amount_cents:100,currency:'THB',saga_id:body.saga_id},{...credentials,commandId:body.create_command_id}),error=>error instanceof PaymentOutcomeUnknownError&&error.operation==='create'&&error.upstreamStatus===409&&error.code===undefined);
 await assert.rejects(client.cancelIntent({...body,reason:'booking_setup_failed'},{...credentials,commandId:'cancel:saga-42'}),error=>error instanceof PaymentOutcomeUnknownError&&error.operation==='cancel'&&error.upstreamStatus===409&&error.code===undefined);
});
