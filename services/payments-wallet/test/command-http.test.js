import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from '../src/app.js';
import { HttpError } from '../src/errors.js';

const f=JSON.parse(await readFile(new URL('../../../contracts/fixtures/payment-intents.json',import.meta.url),'utf8'));
const clone=value=>structuredClone(value);
const callerId='test-issuer|booking-client';
// Explicit test verifier/command doubles. No real Keycloak or durable C semantics.
const authenticateService=async (req,{operation}) => {
  assert.ok(['create','query','cancel','activate'].includes(operation));
  if (req.get('authorization') !== 'Bearer booking-fixture') throw new HttpError(401,'invalid fixture token');
  return {service:'booking',callerId};
};
async function setup(t,overrides={}) {
  const calls=[];
  const paymentCommands={
    create:async input=>{calls.push(['create',input]);return {replayed:false,result:clone(f.created)};},
    get:async input=>{calls.push(['get',input]);return clone(f.created);},
    cancel:async input=>{calls.push(['cancel',input]);return clone(f.cancelled);},
  };
  const app=createApp({database:{query:()=>assert.fail('HTTP shell must not query SQL')},authenticateService,paymentCommands,...overrides});
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=(path,options={})=>fetch(base+path,{...options,headers:{Authorization:'Bearer booking-fixture',...options.headers}});
  const post=(path,body,commandId=f.create.headers['Idempotency-Key'],headers={})=>request(path,{method:'POST',body:JSON.stringify(body),headers:{'Content-Type':'application/json','Idempotency-Key':commandId,...headers}});
  return {calls,paymentCommands,request,post};
}
const createPath='/internal/payment-intents',cancelPath=createPath+'/cancel-by-command';
const queryPath='/internal/payment-operations/'+f.created.create_command_id;

test('internal HTTP fails closed without B verifier or corresponding C method',async t=>{
  for (const options of [{authenticateService:undefined},{paymentCommands:{}},{paymentCommands:undefined}]) {
    const {request,post,calls}=await setup(t,options);
    for (const response of [await post(createPath,f.create.body),await request(queryPath),await post(cancelPath,f.cancel.body,f.cancel.headers['Idempotency-Key'])]) {
      assert.equal(response.status,503);assert.equal(response.headers.get('retry-after'),'2');
      assert.deepEqual(Object.keys(await response.json()).sort(),['error','requestId']);
    }
    assert.equal(calls.length,0);
  }
});
test('service authentication rejects missing/invalid bearer, end users and forged identity',async t=>{
  const {request,post,calls}=await setup(t);
  for (const authorization of ['', 'Bearer forged', 'Basic booking-fixture']) {
    const response=await post(createPath,f.create.body,undefined,{Authorization:authorization,'X-Role':'booking','X-User-Id':'7'});
    assert.equal(response.status,401);
  }
  const other=await setup(t,{authenticateService:async()=>({service:'customer',callerId:'customer:7'})});
  assert.equal((await other.post(createPath,f.create.body)).status,403);
  const user=await setup(t,{authenticateService:async()=>({role:'admin',domainId:7})});
  assert.equal((await user.request(queryPath)).status,401);
  assert.equal(calls.length,0);
});
test('create returns 201 or replay 200 from C and passes stable caller/key plus safe metadata',async t=>{
  const {post,calls,paymentCommands}=await setup(t);
  const response=await post(createPath,f.create.body,undefined,{'X-Request-Id':'command-http-probe',traceparent:'00-11111111111111111111111111111111-2222222222222222-01'});
  assert.equal(response.status,201);assert.deepEqual(await response.json(),f.created);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(response.headers.get('x-request-id'),'command-http-probe');
  const input=calls[0][1];
  assert.equal(input.callerId,callerId);assert.equal(input.commandId,f.created.create_command_id);
  assert.deepEqual(input.request,f.create.body);
  assert.equal(input.context.requestId,'command-http-probe');
  assert.ok(input.context.traceparent);
  assert.ok(!JSON.stringify(input).includes('Bearer'));
  paymentCommands.create=async()=>({replayed:true,result:clone(f.created)});
  assert.equal((await post(createPath,f.create.body)).status,200);
});
test('query projects created/cancelled or unknown 404 and never invents a safe fence',async t=>{
  const {request,paymentCommands,calls}=await setup(t);
  assert.deepEqual(await (await request(queryPath)).json(),f.created);
  assert.equal(calls[0][1].callerId,callerId);assert.equal(calls[0][1].createCommandId,f.created.create_command_id);
  paymentCommands.get=async()=>clone(f.cancelled);
  assert.deepEqual(await (await request(queryPath)).json(),f.cancelled);
  paymentCommands.get=async()=>null;
  assert.equal((await request(queryPath)).status,404);
});
test('cancel requires distinct keys and forwards the original command/saga to C',async t=>{
  const {post,calls}=await setup(t);
  assert.equal((await post(cancelPath,f.cancel.body,f.created.create_command_id)).status,400);
  assert.equal(calls.length,0);
  const response=await post(cancelPath,f.cancel.body,f.cancel.headers['Idempotency-Key']);
  assert.equal(response.status,200);assert.deepEqual(await response.json(),f.cancelled);
  assert.equal(calls[0][1].callerId,callerId);
  assert.equal(calls[0][1].commandId,f.cancel.headers['Idempotency-Key']);
  assert.deepEqual(calls[0][1].request,f.cancel.body);
});
test('invalid command context, keys and unknown fields never reach C',async t=>{
  const {post,request,calls}=await setup(t);
  for (const fields of [{order_id:0},{order_id:'42'},{provider_id:2147483648},{amount_cents:-1},{amount_cents:1.5},{currency:'USD'},{saga_id:'.'},{extra:true}]) {
    assert.equal((await post(createPath,{...f.create.body,...fields})).status,400);
  }
  for (const key of ['', '.', '..','bad key','a'.repeat(129)]) assert.equal((await post(createPath,f.create.body,key)).status,400);
  assert.equal((await post(cancelPath,{...f.cancel.body,reason:'arbitrary'},f.cancel.headers['Idempotency-Key'])).status,400);
  assert.equal((await request('/internal/payment-operations/%2E%2E?ignored=1')).status===200,false);
  assert.equal((await request(queryPath+'?callerId=forged')).status,400);
  assert.equal(calls.length,0);
});
test('JSON syntax, object shape, media type, encoding and size errors are controlled',async t=>{
  const {request,post,calls}=await setup(t);
  const send=(body,headers={})=>request(createPath,{method:'POST',body,headers:{'Content-Type':'application/json','Idempotency-Key':f.created.create_command_id,...headers}});
  assert.equal((await send('{')).status,400);
  assert.equal((await post(createPath,[])).status,400);
  assert.equal((await post(createPath,null)).status,400);
  assert.equal((await send('{}',{'Content-Type':'text/plain'})).status,415);
  assert.equal((await send('{}',{'Content-Encoding':'gzip'})).status,415);
  assert.equal((await post(createPath,{...f.create.body,padding:'x'.repeat(17000)})).status,413);
  assert.equal(calls.length,0);
});
test('C conflict/unknown/failure statuses are sanitized and not turned into success',async t=>{
  const {post,paymentCommands}=await setup(t);
  for (const status of [409,503]) {
    paymentCommands.create=async()=>{throw new HttpError(status,'fixture conflict');};
    assert.equal((await post(createPath,f.create.body)).status,status);
  }
  paymentCommands.create=async()=>{throw new Error('private database password fixture');};
  const response=await post(createPath,f.create.body);
  assert.equal(response.status,500);assert.ok(!JSON.stringify(await response.json()).includes('password'));
});
test('invalid/mismatched C success payloads fail closed and never expose private fields',async t=>{
  const {post,request,paymentCommands}=await setup(t);
  for (const changed of [{...f.created,saga_id:'wrong'},{...f.created,create_command_id:'wrong'},{...f.created,payment_intent:{...f.created.payment_intent,order_id:99}},{...f.created,payment_intent:{...f.created.payment_intent,amount_cents:1}},{...f.created,secret:'never expose'}]) {
    paymentCommands.create=async()=>({replayed:false,result:changed});
    const response=await post(createPath,f.create.body);
    assert.equal(response.status,503);assert.ok(!JSON.stringify(await response.json()).includes('never expose'));
  }
  paymentCommands.get=async()=>({...f.created,create_command_id:'wrong'});
  assert.equal((await request(queryPath)).status,503);
  paymentCommands.cancel=async()=>clone(f.created);
  assert.equal((await post(cancelPath,f.cancel.body,f.cancel.headers['Idempotency-Key'])).status,503);
});
test('activation stays reserved/unavailable even if an arbitrary activate function is supplied',async t=>{
  const {post}=await setup(t,{paymentCommands:{activate:()=>assert.fail('unagreed activation interface must not run')}});
  assert.equal((await post(createPath+'/activate-by-command',{})).status,503);
});
