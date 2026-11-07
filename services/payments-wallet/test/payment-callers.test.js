import test from 'node:test';
import assert from 'node:assert/strict';
import {randomInt,randomUUID} from 'node:crypto';
import {createApp} from '../src/app.js';
import {createDatabase} from '../src/database.js';
import {migrate} from '../src/migrations.js';
import {createPaymentsService} from '../src/service.js';
import {createPaymentParticipant} from '../src/participant/index.js';
import {createOutbox} from '../src/messaging/outbox.js';
import {HttpError} from '../src/errors.js';
async function serve(t,options){const server=createApp(options).listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));return `http://127.0.0.1:${server.address().port}`;}
test('intent and simulation endpoints fail closed without auth',async t=>{
 const url=await serve(t,{database:{query:()=>assert.fail('no SQL before auth')}});
 assert.equal((await fetch(url+'/api/booking-payment-intents/42')).status,503);
 assert.equal((await fetch(url+'/api/payments/simulate',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"order_id":42}'})).status,503);
});
test('intent/guarded simulation/wallet setup on PostgreSQL',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const db=createDatabase(process.env.TEST_DATABASE_URL),id=randomInt(180000000,190000000),caller='caller-view|'+randomUUID();let participant;
 const hooks={assertSettlementAllowed:(client,intent)=>participant.assertSettlementAllowed(client,intent),stageEvent:createOutbox().stage};
 const business=createPaymentsService(db,hooks);participant=createPaymentParticipant({database:db,business});
 const request={order_id:id,customer_id:id+1,provider_id:id+2,amount_cents:1500,currency:'THB',saga_id:`caller-saga-${id}`};
 const createId=`create:${id}`,activateId=`activate:${id}`;
 const actors={customer:{role:'customer',domainId:id+1},provider:{role:'provider',domainId:id+2},other:{role:'customer',domainId:id+3}};
 const authenticate=async req=>{const actor=actors[req.get('authorization')?.replace('Bearer ','')];if(!actor)throw new HttpError(401,'invalid test token');return actor;};
 try{
  await migrate(db);await participant.create({callerId:caller,commandId:createId,request});
  const url=await serve(t,{database:db,authenticate,paymentHooks:hooks});
  const get=(path,token='customer')=>fetch(url+path,{headers:{Authorization:`Bearer ${token}`}});
  const post=(value,token='customer',headers={})=>fetch(url+'/api/payments/simulate',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...headers},body:typeof value==='string'?value:JSON.stringify(value)});
  await t.test('intent is scoped to the verified customer/provider and failed auth precedes mutation',async()=>{
   for(const token of ['customer','provider']){const response=await get(`/api/booking-payment-intents/${id}`,token);assert.equal(response.status,200);assert.equal((await response.json()).order_id,id);}
   assert.equal((await get(`/api/booking-payment-intents/${id}`,'other')).status,403);
   assert.equal((await get('/api/booking-payment-intents/1e2')).status,400);
   assert.equal((await post({order_id:id},'other')).status,403);assert.equal((await post({order_id:id},'provider')).status,403);
   assert.equal((await post({order_id:id,payment_setup:'ready'})).status,400);
   assert.equal((await post('{')).status,400);assert.equal((await post({order_id:id},'customer',{'Content-Type':'text/plain'})).status,415);
  });
  await t.test('missing wallet is pending with unknown balances, later provisioning preserves real data',async()=>{
   const pending=await(await get('/api/provider/wallet','provider')).json();assert.equal(pending.wallet_setup,'pending');assert.equal(pending.balance_cents,null);
   await business.provisionWallet(id+2);await db.query('UPDATE provider_wallets SET balance_cents=850,commission_owed_cents=150 WHERE provider_id=$1',[id+2]);
   const wallet=await(await get('/api/provider/wallet','provider')).json();assert.equal(wallet.wallet_setup,undefined);assert.equal(wallet.balance_cents,850);assert.equal(wallet.commission_owed_cents,150);
  });
  await t.test('UI hints cannot bypass server eligibility; active settlement is replay-safe and emits one event',async()=>{
   assert.equal((await post({order_id:id},'customer',{'X-Payment-Setup':'ready'})).status,409);
   assert.equal((await db.query('SELECT 1 FROM transactions WHERE order_id=$1',[id])).rowCount,0);
   await participant.activate({callerId:caller,commandId:activateId,request:{create_command_id:createId,saga_id:request.saga_id}});
   const paid=await post({order_id:id});assert.equal(paid.status,200);assert.equal((await paid.json()).settled,true);
   const again=await post({order_id:id});assert.equal(again.status,200);assert.equal((await again.json()).already_settled,true);
   assert.equal((await db.query("SELECT count(*)::int AS n FROM transactions WHERE order_id=$1 AND kind='charge'",[id])).rows[0].n,1);
   assert.equal((await db.query("SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id=$1 AND event_type='payment.succeeded'",[String(id)])).rows[0].n,1);
  });
  await t.test('verified user auth alone is insufficient without both C settlement hooks',async()=>{
   const noHooks=await serve(t,{database:db,authenticate});
   const response=await fetch(noHooks+'/api/payments/simulate',{method:'POST',headers:{Authorization:'Bearer customer','Content-Type':'application/json'},body:JSON.stringify({order_id:id})});assert.equal(response.status,503);
  });
 }finally{
  try{await db.query('DELETE FROM payment_commands WHERE caller_id=$1',[caller]);await db.query('DELETE FROM payment_provisioning WHERE caller_id=$1',[caller]);await db.query('DELETE FROM outbox_events WHERE aggregate_id=$1',[String(id)]);await db.query('DELETE FROM webhook_events WHERE payload_json->>\'gateway_ref\' IN (SELECT gateway_ref FROM payment_intents WHERE order_id=$1)',[id]);await db.query('DELETE FROM transactions WHERE order_id=$1',[id]);await db.query('DELETE FROM payment_intents WHERE order_id=$1',[id]);await db.query('DELETE FROM provider_wallets WHERE provider_id=$1',[id+2]);}finally{await db.close();}
 }
});
