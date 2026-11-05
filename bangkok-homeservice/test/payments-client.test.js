import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createPaymentsClient,PaymentOutcomeUnknownError } from "../lib/modules/payments/client.js";
import { createBookingPaymentsAdapter } from "../lib/modules/booking/payment-adapter.js";
const context={order_id:42,customer_id:7,provider_id:3,amount_cents:150000,currency:"THB",saga_id:"booking-saga:42"};
const createId="intent-create:booking-42",cancelId="intent-cancel:booking-42";
const created={create_command_id:createId,saga_id:context.saga_id,outcome:"created",payment_intent:{id:1,order_id:42,amount_cents:150000,gateway_ref:"mock_intent_example_1",status:"requires_payment"}};
const cancelled={create_command_id:createId,saga_id:context.saga_id,outcome:"cancelled"};
const lookup={create_command_id:createId,saga_id:context.saga_id,order_id:context.order_id,amount_cents:context.amount_cents};
const cancel={create_command_id:createId,saga_id:context.saga_id,reason:"booking_finalization_failed"};
const row={id:1,order_id:42,kind:"charge",amount_cents:150000,method:"gateway",gateway_ref:"mock_intent_example_1",status:"succeeded",created_at:"2026-11-05T00:00:00.000Z"};
const wallet={provider_id:3,balance_cents:0,commission_owed_cents:0,transactions:[row]};
const credentials={token:"test-token",requestId:"payments-client-1",traceparent:"00-01234567890123456789012345678901-0123456789012345-01",tracestate:"demo=1"};
async function serve(t,handler) {
  const server=http.createServer((req,res)=>{Promise.resolve(handler(req,res)).catch(()=>{res.statusCode=500;res.end();});}).listen(0,"127.0.0.1");
  await new Promise(resolve=>server.once("listening",resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  return `http://127.0.0.1:${server.address().port}`;
}
function send(res,status,body){res.writeHead(status,{"Content-Type":"application/json"});res.end(JSON.stringify(body));}
async function bodyOf(req){let body="";for await(const chunk of req)body+=chunk;return body?JSON.parse(body):undefined;}
function unknown(error,operation="create"){assert.ok(error instanceof PaymentOutcomeUnknownError);assert.equal(error.statusCode,503);assert.equal(error.outcomeUnknown,true);assert.equal(error.createCommandId,createId);assert.equal(error.operation,operation);return true;}

test("Payments reads forward bearer/tracing and preserve strict public payloads",async t=>{
  const calls=[];const baseUrl=await serve(t,(req,res)=>{calls.push(req);send(res,200,req.url==="/api/provider/wallet"?wallet:[row]);});
  const client=createPaymentsClient({baseUrl});
  assert.deepEqual(await client.getWallet(credentials),wallet);assert.deepEqual(await client.listCustomerTransactions(credentials),[row]);
  assert.deepEqual(calls.map(req=>[req.method,req.url]),[["GET","/api/provider/wallet"],["GET","/api/customer/transactions"]]);
  for(const [header,value] of [["authorization","Bearer test-token"],["x-request-id",credentials.requestId],["traceparent",credentials.traceparent],["tracestate",credentials.tracestate]])assert.equal(calls[0].headers[header],value);
  assert.equal(calls[0].headers["x-role"],undefined);assert.equal(calls[0].headers["x-user-id"],undefined);
});
test("explicit create/replay reuse caller key and JSON body without mutating input",async t=>{
  const calls=[];const baseUrl=await serve(t,async(req,res)=>{calls.push({url:req.url,headers:req.headers,body:await bodyOf(req)});send(res,calls.length===1?201:200,created);});
  const client=createPaymentsClient({baseUrl}),original=structuredClone(context);
  assert.deepEqual(await client.createIntent(context,{...credentials,commandId:createId}),created);
  assert.deepEqual(await client.createIntent(context,{...credentials,commandId:createId}),created);assert.deepEqual(context,original);
  assert.equal(calls.length,2);for(const call of calls){assert.equal(call.url,"/internal/payment-intents");assert.equal(call.headers["idempotency-key"],createId);assert.equal(call.headers["content-type"],"application/json");assert.deepEqual(call.body,context);}
});
test("query encodes the original key; cancel uses a distinct stable command",async t=>{
  const calls=[];const baseUrl=await serve(t,async(req,res)=>{calls.push({url:req.url,key:req.headers["idempotency-key"],body:await bodyOf(req)});send(res,200,req.method==="GET"?created:cancelled);});
  const client=createPaymentsClient({baseUrl});assert.deepEqual(await client.getOperation(lookup,credentials),created);
  assert.deepEqual(await client.cancelIntent(cancel,{...credentials,commandId:cancelId}),cancelled);
  assert.equal(calls[0].url,"/internal/payment-operations/"+encodeURIComponent(createId));assert.equal(calls[0].key,undefined);
  assert.equal(calls[1].url,"/internal/payment-intents/cancel-by-command");assert.equal(calls[1].key,cancelId);assert.deepEqual(calls[1].body,cancel);
});
test("only matching terminal cancellation confirms cancellation",async t=>{
  const baseUrl=await serve(t,(_req,res)=>send(res,200,cancelled));assert.deepEqual(await createPaymentsClient({baseUrl}).getOperation(lookup,credentials),cancelled);
});
test("lookup 404 is UNKNOWN, never a safe cancellation",async t=>{
  let requests=0;const baseUrl=await serve(t,(_req,res)=>{requests++;send(res,404,{error:"not found",requestId:"probe"});});
  await assert.rejects(createPaymentsClient({baseUrl}).getOperation(lookup,credentials),error=>{unknown(error,"query");assert.equal(error.reason,"lookup_missing");assert.equal(error.upstreamStatus,404);return true;});assert.equal(requests,1);
});
test("command HTTP errors cannot disprove an earlier write and never leak details",async t=>{
  for(const status of [400,401,403,404,409,500,503]){
    const baseUrl=await serve(t,(_req,res)=>send(res,status,{error:"private password and stack"}));const client=createPaymentsClient({baseUrl});
    await assert.rejects(client.createIntent(context,{token:"PRIVATE-TEST-TOKEN",commandId:createId}),error=>{unknown(error);assert.equal(error.upstreamStatus,status);assert.ok(!JSON.stringify(error).includes("password"));assert.ok(!JSON.stringify(error).includes("PRIVATE-TEST-TOKEN"));return true;});
    await assert.rejects(client.cancelIntent(cancel,{...credentials,commandId:cancelId}),error=>unknown(error,"cancel"));
  }
});
test("lost reply is followed only by explicit retry with identical key/body",async t=>{
  const calls=[];const baseUrl=await serve(t,async(req,res)=>{calls.push({key:req.headers["idempotency-key"],body:await bodyOf(req)});if(calls.length===1)res.destroy();else send(res,200,created);});
  const client=createPaymentsClient({baseUrl});await assert.rejects(client.createIntent(context,{...credentials,commandId:createId}),unknown);assert.equal(calls.length,1);
  assert.deepEqual(await client.createIntent(context,{...credentials,commandId:createId}),created);assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);
});
test("mismatched command/saga/order/amount and voided creation remain UNKNOWN",async t=>{
  for(const sample of [{...created,create_command_id:"another"},{...created,saga_id:"another"},...Object.entries({order_id:43,amount_cents:1,status:"failed"}).map(([key,value])=>({...created,payment_intent:{...created.payment_intent,[key]:value}}))]){
    const baseUrl=await serve(t,(_req,res)=>send(res,201,sample));await assert.rejects(createPaymentsClient({baseUrl}).createIntent(context,{...credentials,commandId:createId}),unknown);
  }
  const baseUrl=await serve(t,(_req,res)=>send(res,200,{...cancelled,saga_id:"wrong"}));await assert.rejects(createPaymentsClient({baseUrl}).cancelIntent(cancel,{...credentials,commandId:cancelId}),error=>unknown(error,"cancel"));
});
test("malformed JSON, body type, extra private fields and unexpected status remain UNKNOWN",async t=>{
  for(const [status,type,payload] of [[201,"application/json","not JSON"],[201,"text/html",JSON.stringify(created)],[202,"application/json",JSON.stringify(created)],[201,"application/json",JSON.stringify({...created,private_context:{}})]]){
    const baseUrl=await serve(t,(_req,res)=>{res.writeHead(status,{"Content-Type":type});res.end(payload);});await assert.rejects(createPaymentsClient({baseUrl}).createIntent(context,{...credentials,commandId:createId}),unknown);
  }
});
test("one deadline includes a stalled body without automatic retry/compensation",{timeout:3000},async t=>{
  let requests=0;const baseUrl=await serve(t,(_req,res)=>{requests++;res.writeHead(201,{"Content-Type":"application/json"});res.flushHeaders();});
  await assert.rejects(createPaymentsClient({baseUrl,timeoutMs:50}).createIntent(context,{...credentials,commandId:createId}),unknown);assert.equal(requests,1);
});
test("redirects never receive forwarded credentials",async t=>{
  let leaked=0;const target=await serve(t,(_req,res)=>{leaked++;send(res,201,created);});const baseUrl=await serve(t,(_req,res)=>{res.writeHead(307,{Location:target});res.end();});
  await assert.rejects(createPaymentsClient({baseUrl}).createIntent(context,{...credentials,commandId:createId}),unknown);assert.equal(leaked,0);
});
test("bad input, missing keys, reused cancel keys and bad identity fail before HTTP",async()=>{
  let requests=0;const client=createPaymentsClient({baseUrl:"http://localhost:3002",fetchImpl:async()=>{requests++;assert.fail();}});
  for(const [input,cred] of [[context,credentials],[{...context,amount_cents:-1},{...credentials,commandId:createId}],[{...context,currency:"USD"},{...credentials,commandId:createId}]])await assert.rejects(client.createIntent(input,cred),error=>error.statusCode===400);
  await assert.rejects(client.cancelIntent(cancel,{...credentials,commandId:createId}),error=>error.statusCode===400);
  await assert.rejects(client.getOperation({...lookup,create_command_id:"../unsafe"},credentials),error=>error.statusCode===400);
  await assert.rejects(client.getWallet({}),error=>error.statusCode===401);await assert.rejects(client.getWallet({...credentials,requestId:"invalid id"}),error=>error.statusCode===400);assert.equal(requests,0);
});
test("read errors preserve expected 4xx; unexpected/private payloads become safe 503",async t=>{
  for(const status of [400,401,403,404,500,503]){const baseUrl=await serve(t,(_req,res)=>send(res,status,{error:"private stack"}));await assert.rejects(createPaymentsClient({baseUrl}).getWallet(credentials),error=>error.statusCode===(status<500?status:503)&&!error.message.includes("private"));}
  const baseUrl=await serve(t,(_req,res)=>send(res,200,{...wallet,transactions:[{...row,context_json:{private:true}}]}));await assert.rejects(createPaymentsClient({baseUrl}).getWallet(credentials),error=>error.statusCode===503);
});
test("client rejects credential-bearing/non-HTTP/non-origin URLs",()=>{
  for(const baseUrl of ["invalid","file:///tmp/payments","http://user:secret@localhost:3002","http://localhost:3002/prefix"])assert.throws(()=>createPaymentsClient({baseUrl}),error=>!error.message.includes("secret"));
});
test("Booking adapter maps trusted pricing/IDs and caller-owned workflow keys",async()=>{
  const calls=[];const adapter=createBookingPaymentsAdapter({paymentsClient:{createIntent:async(...args)=>{calls.push(args);return created;},getOperation:(...args)=>{calls.push(args);return Promise.resolve(created);},cancelIntent:(...args)=>{calls.push(args);return Promise.resolve(cancelled);}}});
  const order={id:42,customer_id:7,provider_id:3,total_cents:150000,payment_method:"gateway",otp:1234,internal_note:"not transported"},workflow={createCommandId:createId,sagaId:context.saga_id};
  assert.deepEqual(await adapter.prepare(order,workflow,credentials),created);assert.deepEqual(calls[0],[context,{...credentials,commandId:createId}]);
  await adapter.inspect(order,workflow,credentials);assert.deepEqual(calls[1],[lookup,credentials]);await adapter.cancel({...workflow,cancelCommandId:cancelId,reason:cancel.reason},credentials);assert.deepEqual(calls[2],[cancel,{...credentials,commandId:cancelId}]);
});
test("COD creates no intent and preserves omitted payment_intent JSON",async()=>{
  const adapter=createBookingPaymentsAdapter({paymentsClient:{createIntent:()=>assert.fail("COD must not call Payments")}});
  const result=await adapter.prepare({id:42,customer_id:7,provider_id:3,total_cents:150000,payment_method:"cod"});assert.equal(result,undefined);assert.equal(JSON.stringify({payment_intent:result}),"{}");
});
test("Booking adapter rejects conflicting keys and propagates UNKNOWN unchanged",async()=>{
  const error=new PaymentOutcomeUnknownError("create",createId,"transport_unavailable");const adapter=createBookingPaymentsAdapter({paymentsClient:{createIntent:async()=>{throw error;},cancelIntent:()=>assert.fail()}});
  const order={id:42,customer_id:7,provider_id:3,total_cents:150000,payment_method:"gateway"},workflow={createCommandId:createId,sagaId:context.saga_id};
  await assert.rejects(adapter.prepare(order,workflow,credentials),received=>received===error);
  await assert.rejects(adapter.prepare(order,workflow,{...credentials,commandId:"wrong"}),received=>received.statusCode===400);
  assert.throws(()=>adapter.cancel({...workflow,cancelCommandId:createId,reason:cancel.reason},credentials),received=>received.statusCode===400);
  await assert.rejects(adapter.prepare({...order,total_cents:-1},workflow,credentials),received=>received.statusCode===400);
});

test("query checks saved booking amount/order as well as operation IDs",async t=>{
  for(const fields of [{order_id:43},{amount_cents:1}]){
    const baseUrl=await serve(t,(_req,res)=>send(res,200,{...created,payment_intent:{...created.payment_intent,...fields}}));
    await assert.rejects(createPaymentsClient({baseUrl}).getOperation(lookup,credentials),error=>unknown(error,"query"));
  }
});
