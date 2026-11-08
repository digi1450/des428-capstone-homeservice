import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {readFile} from 'node:fs/promises';
import {createFinancialClient,FinancialOutcomeUnknownError,FinancialReconciliationError} from '../lib/modules/payments/financial-client.js';
const f=JSON.parse(await readFile(new URL('../../contracts/fixtures/financial-finalization.json',import.meta.url),'utf8'));
async function setup(t){let answer={status:200,body:f.results.completionGatewayReady},count=0;const seen=[];
 const server=http.createServer(async(req,res)=>{count++;const parts=[];for await(const c of req)parts.push(c);seen.push({url:req.url,headers:req.headers,body:parts.length?JSON.parse(Buffer.concat(parts)):null});res.writeHead(answer.status,{'Content-Type':answer.media??'application/json',...(answer.headers??{})});if(answer.delay){res.write(' ');return;}res.end(answer.raw??JSON.stringify(answer.body));});
 server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
 const origin=`http://127.0.0.1:${server.address().port}`;return{client:createFinancialClient({baseUrl:origin,timeoutMs:100}),origin,seen,count:()=>count,answer:v=>{answer=v;}};}
const work=key=>({commandId:f[key].command_id,request:f[key].request});const creds={token:'fixture-booking-token',requestId:'financial-fixture'};
test('financial client sends exact saved key/context and accepts ready/pending/attention',async t=>{
 const p=await setup(t);await p.client.complete(work('completeGateway'),creds);await p.client.complete(work('completeGateway'),creds);
 assert.equal(p.seen[0].headers['idempotency-key'],p.seen[1].headers['idempotency-key']);assert.deepEqual(p.seen[0].body,f.completeGateway.request);
 p.answer({status:202,body:f.results.cancelPending});assert.equal((await p.client.cancel(work('cancelGateway'),creds)).state,'pending');
 p.answer({status:409,body:f.results.cancelAttention});assert.equal((await p.client.cancel(work('cancelGateway'),creds)).state,'attention');
 p.answer({status:200,body:f.results.cancelAttention});assert.equal((await p.client.getOperation({...work('cancelGateway'),kind:'cancellation'},creds)).state,'attention');
 assert.match(p.seen.at(-1).url,/cancel%3A/);assert.equal(p.seen.at(-1).body,null);
});
test('wrong success/status/echo are unknown; coded/uncoded/malformed409 require reconciliation',async t=>{
 const p=await setup(t);
 for(const answer of [{status:200,body:f.results.completionPending},{status:202,body:f.results.completionGatewayReady},{status:200,body:{...f.results.completionGatewayReady,command_id:f.completeCod.command_id}},{status:503,body:f.error},{status:404,body:f.error}]){p.answer(answer);await assert.rejects(p.client.complete(work('completeGateway'),creds),FinancialOutcomeUnknownError);}
 for(const status of [401,403]){p.answer({status,media:'text/html',raw:'denied'});await assert.rejects(p.client.complete(work('completeGateway'),creds),e=>e.statusCode===status);}
 for(const answer of [{status:409,body:f.conflicts[0]},{status:409,body:f.error},{status:409,media:'text/html',raw:'no'},{status:409,raw:'{bad'}]){p.answer(answer);await assert.rejects(p.client.complete(work('completeGateway'),creds),FinancialReconciliationError);}
});
test('deadline covers response body; oversized/redirect replies do not succeed or retry',async t=>{
 const p=await setup(t),client=createFinancialClient({baseUrl:p.origin,timeoutMs:25});
 p.answer({status:200,delay:true});await assert.rejects(client.complete(work('completeGateway'),creds),FinancialOutcomeUnknownError);
 p.answer({status:200,raw:' '.repeat(17000)});await assert.rejects(p.client.complete(work('completeGateway'),creds),FinancialOutcomeUnknownError);
 p.answer({status:302,headers:{Location:'/token-capture'},body:{}});const before=p.count();await assert.rejects(p.client.complete(work('completeGateway'),creds),FinancialOutcomeUnknownError);assert.equal(p.count(),before+1);
});
test('invalid caller material is rejected before network and webhook preserves its own ack union',async t=>{
 const p=await setup(t);await assert.rejects(p.client.complete(work('completeGateway'),{token:'bad\ncredential'}),e=>e.statusCode===401);assert.equal(p.count(),0);
 assert.throws(()=>p.client.complete({...work('completeGateway'),commandId:f.completeCod.command_id},creds),e=>e.statusCode===400);
 p.answer({status:200,body:f.webhookAcks[0]});assert.equal((await p.client.settleWebhook(f.webhook,{token:'gateway-fixture'})).received,true);
 p.answer({status:200,body:{received:true}});await assert.rejects(p.client.settleWebhook(f.webhook,{token:'gateway-fixture'}),FinancialOutcomeUnknownError);
});
