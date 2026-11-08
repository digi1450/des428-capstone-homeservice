import {freshBoot} from '../../bangkok-homeservice/test-helpers/boot.js';
import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {randomUUID,randomInt} from 'node:crypto';
import {createFinancialClient,FinancialOutcomeUnknownError,FinancialReconciliationError} from '../../bangkok-homeservice/lib/modules/payments/financial-client.js';
import {createDatabase} from '../../services/payments-wallet/src/database.js';import {migrate} from '../../services/payments-wallet/src/migrations.js';import {createPaymentsRuntime} from '../../services/payments-wallet/src/runtime.js';import {HttpError} from '../../services/payments-wallet/src/errors.js';
const f=JSON.parse(await readFile(new URL('../../contracts/fixtures/financial-finalization.json',import.meta.url),'utf8'));
test('A client -> Express financial seam; callback -> actual C eligibility/PG (financial participant is a labeled fixture)',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 freshBoot();const db=createDatabase(process.env.TEST_DATABASE_URL),callerId='transport-fixture:'+randomUUID(),orderId=randomInt(1100000000,1200000000);let server,result=structuredClone(f.results.completionGatewayReady),fail=false;
 try{
  await migrate(db);
  const verify=async req=>{if(req.get('authorization')!=='Bearer service-fixture')throw new HttpError(401,'fixture rejected');return{service:'booking',callerId};};
  const runtime=createPaymentsRuntime({database:db,authenticate:async()=>{throw new HttpError(403,'not user flow');},authenticateService:verify,authenticateWebhook:async req=>{if(req.get('authorization')!=='Bearer gateway-fixture')throw new HttpError(403,'gateway only');return{service:'mock-gateway',callerId:'gateway-fixture'};},createFinancialOperations:()=>({
   complete:async input=>{assert.equal(input.callerId,callerId);if(fail)throw new HttpError(503,'fixture unavailable');return{replayed:false,result:structuredClone(result)};},
   cancel:async()=>({replayed:false,result:structuredClone(result)}),get:async()=>structuredClone(result),
  })}); // Completion/cancel fixture has NO durable financial store or money effect.
  server=runtime.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`,client=createFinancialClient({baseUrl:base}),credentials={token:'service-fixture'};
  const complete={commandId:f.completeGateway.command_id,request:f.completeGateway.request},cancel={commandId:f.cancelGateway.command_id,request:f.cancelGateway.request};
  await t.test('consumer/provider agree on ready/pending/attention and query state',async()=>{
   assert.deepEqual(await client.complete(complete,credentials),result);
   result=f.results.cancelPending;assert.equal((await client.cancel(cancel,credentials)).state,'pending');
   result=f.results.cancelAttention;assert.equal((await client.cancel(cancel,credentials)).state,'attention');assert.equal((await client.getOperation({...cancel,kind:'cancellation'},credentials)).state,'attention');
  });
  await t.test('malformed C result and unavailable transport cannot turn into success',async()=>{
   result={...f.results.cancelPending,state:'ready'};await assert.rejects(client.cancel(cancel,credentials),FinancialOutcomeUnknownError);
   fail=true;await assert.rejects(client.complete(complete,credentials),FinancialOutcomeUnknownError);fail=false;
   result={...f.results.cancelAttention,request:{...f.cancelGateway.request,amount_cents:1}};await assert.rejects(client.cancel(cancel,credentials),FinancialOutcomeUnknownError);
  });
  await t.test('dedicated client callback settles one real PG charge/outbox after actual C activation',async()=>{
   const createId='boundary-create:'+randomUUID(),sagaId='boundary-saga:'+randomUUID();
   const created=await runtime.participant.create({callerId,commandId:createId,request:{order_id:orderId,customer_id:7,provider_id:3,amount_cents:107,currency:'THB',saga_id:sagaId}});
   await runtime.participant.activate({callerId,commandId:'activate:'+randomUUID(),request:{create_command_id:createId,saga_id:sagaId}});
   const input={gateway_event_id:'boundary-event:'+randomUUID(),type:'payment_intent.succeeded',gateway_ref:created.result.payment_intent.gateway_ref};
   await assert.rejects(client.settleWebhook(input,credentials),e=>e.statusCode===403);
   assert.equal((await client.settleWebhook(input,{token:'gateway-fixture'})).settled,true);
   assert.equal((await client.settleWebhook(input,{token:'gateway-fixture'})).replayed,true);
   assert.equal((await db.query("SELECT 1 FROM transactions WHERE order_id=$1 AND kind='charge'",[orderId])).rowCount,1);
   assert.equal((await db.query('SELECT 1 FROM outbox_events WHERE aggregate_id=$1',[String(orderId)])).rowCount,1);
  });
 }finally{
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  try{await db.query('DELETE FROM payment_commands WHERE caller_id=$1',[callerId]);await db.query('DELETE FROM payment_provisioning WHERE caller_id=$1',[callerId]);await db.query("DELETE FROM webhook_events WHERE payload_json->>'gateway_ref' IN(SELECT gateway_ref FROM payment_intents WHERE order_id=$1)",[orderId]);await db.query('DELETE FROM outbox_events WHERE aggregate_id=$1',[String(orderId)]);await db.query('DELETE FROM transactions WHERE order_id=$1',[orderId]);await db.query('DELETE FROM payment_intents WHERE order_id=$1',[orderId]);}finally{await db.close();}
 }
});
