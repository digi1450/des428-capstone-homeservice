import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID,randomInt} from 'node:crypto';
import {createDatabase} from '../src/database.js';import {migrate} from '../src/migrations.js';import {createPaymentsRuntime} from '../src/runtime.js';import {HttpError} from '../src/errors.js';
test('new callback HTTP -> real C eligibility -> PG charge/receipt/outbox',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const db=createDatabase(process.env.TEST_DATABASE_URL),orderId=randomInt(1000000000,1100000000),callerId='callback-fixture:'+randomUUID();let server;
 const createId='callback-create:'+randomUUID(),sagaId='callback-saga:'+randomUUID();
 try{
  await migrate(db);
  const runtime=createPaymentsRuntime({database:db,authenticate:async()=>{throw new HttpError(403,'not a user flow');},authenticateService:async req=>{if(req.get('authorization')!=='Bearer booking-fixture')throw new HttpError(401,'invalid fixture');return{service:'booking',callerId};},authenticateWebhook:async req=>{if(req.get('authorization')!=='Bearer gateway-fixture')throw new HttpError(403,'gateway verifier required');return{service:'mock-gateway',callerId:'stable-gateway-fixture'};}});
  server=runtime.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(path,input,token='booking-fixture',key)=>fetch(base+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Request-Id':'financial-callback-fixture',...(key?{'Idempotency-Key':key}:{})},body:JSON.stringify(input)});
  const created=await post('/internal/payment-intents',{order_id:orderId,customer_id:7,provider_id:3,amount_cents:107,currency:'THB',saga_id:sagaId},'booking-fixture',createId);
  assert.equal(created.status,201);const intent=(await created.json()).payment_intent;
  const callback={gateway_event_id:'fixture-event:'+randomUUID(),type:'payment_intent.succeeded',gateway_ref:intent.gateway_ref};
  await t.test('distinct gateway auth and provisioning eligibility reject before a charge commits',async()=>{
   assert.equal((await post('/api/payments/webhook',callback,'booking-fixture')).status,403);
   assert.equal((await post('/api/payments/webhook',callback,'gateway-fixture')).status,409);
   assert.equal((await db.query('SELECT 1 FROM transactions WHERE order_id=$1',[orderId])).rowCount,0);
   assert.equal((await db.query('SELECT 1 FROM webhook_events WHERE gateway_event_id=$1',[callback.gateway_event_id])).rowCount,0);
  });
  await t.test('real activation then callback/replays produce one charge/outbox and durable correlation',async()=>{
   assert.equal((await post('/internal/payment-intents/activate-by-command',{create_command_id:createId,saga_id:sagaId},'booking-fixture','activate:'+randomUUID())).status,200);
   let response=await post('/api/payments/webhook',callback,'gateway-fixture');assert.equal(response.status,200);assert.equal((await response.json()).settled,true);
   response=await post('/api/payments/webhook',callback,'gateway-fixture');assert.equal((await response.json()).replayed,true);
   response=await post('/api/payments/webhook',{...callback,gateway_event_id:'fixture-event:'+randomUUID()},'gateway-fixture');assert.equal((await response.json()).already_settled,true);
   assert.equal((await db.query("SELECT 1 FROM transactions WHERE order_id=$1 AND kind='charge'",[orderId])).rowCount,1);
   const outbox=await db.query('SELECT headers FROM outbox_events WHERE aggregate_id=$1',[String(orderId)]);assert.equal(outbox.rowCount,1);assert.equal(outbox.rows[0].headers['x-request-id'],'financial-callback-fixture');
  });
  await t.test('changed receipt identity against another real intent cannot create another charge',async()=>{
   const other=await runtime.business.prepareIntent({order_id:orderId+1,customer_id:7,provider_id:3,amount_cents:107,currency:'THB'});
   assert.equal((await post('/api/payments/webhook',{...callback,gateway_ref:other.gateway_ref},'gateway-fixture')).status,409);
   assert.equal((await db.query('SELECT 1 FROM transactions WHERE order_id=$1',[orderId+1])).rowCount,0);
  });
 }finally{
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  try{
   await db.query('DELETE FROM payment_commands WHERE caller_id=$1',[callerId]);await db.query('DELETE FROM payment_provisioning WHERE caller_id=$1',[callerId]);
   await db.query("DELETE FROM webhook_events WHERE payload_json->>'gateway_ref' IN (SELECT gateway_ref FROM payment_intents WHERE order_id=ANY($1::int[]))",[[orderId,orderId+1]]);
   await db.query('DELETE FROM outbox_events WHERE aggregate_id=ANY($1::text[])',[[String(orderId),String(orderId+1)]]);await db.query('DELETE FROM transactions WHERE order_id=ANY($1::int[])',[[orderId,orderId+1]]);await db.query('DELETE FROM payment_intents WHERE order_id=ANY($1::int[])',[[orderId,orderId+1]]);
  }finally{await db.close();}
 }
});
