import {freshBoot,getDb} from '../test-helpers/boot.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {signToken} from '../lib/http/auth.js';
import {configurePaymentsAccess,resetPaymentsAccess} from '../lib/modules/payments/access.js';
import {resetBookingSaga} from '../lib/modules/booking/saga.js';
import {call} from '../test-helpers/call.js';
import {canSimulatePayment} from '../app/_ui/payment-state.js';
import * as details from '../app/api/bookings/[id]/route.js';
import * as simulate from '../app/api/payments/simulate/route.js';
import * as bookings from '../app/api/bookings/route.js';
import * as wallet from '../app/api/provider/wallet/route.js';
import * as history from '../app/api/customer/transactions/route.js';
import {AppError} from '../lib/errors.js';
function fixture(saga=false){
 freshBoot();resetPaymentsAccess();resetBookingSaga();const db=getDb();
 const customer=db.prepare('SELECT id FROM customers ORDER BY id LIMIT 1').get().id;
 const provider=db.prepare('SELECT id FROM providers ORDER BY id LIMIT 1').get().id;
 const id=db.prepare(`INSERT INTO orders(customer_id,provider_id,service_date,starting_time,ending_time,duration_min,subtotal_cents,tax_cents,total_cents,commission_pct,payment_method,otp) VALUES (?,?,'2026-12-01','10:00','10:30',30,100,7,107,10,'gateway',1234)`).run(customer,provider).lastInsertRowid;
 db.prepare("INSERT INTO slot_holds(provider_id,service_date,slot_time,order_id) VALUES (?,'2026-12-01','10:00',?)").run(provider,id);
 db.prepare("INSERT INTO payment_intents(order_id,amount_cents,gateway_ref) VALUES (?,107,'LOCAL-SENTINEL')").run(id);
 if(saga) db.prepare(`INSERT INTO booking_sagas(saga_id,order_id,customer_id,request_key,request_digest,state,create_command_id,cancel_command_id,snapshot_json,intent_json) VALUES ('view-saga',?,?,'view-key','digest','COMPLETED','create:view','cancel:view','{}','{"id":7}')`).run(id,customer);
 const token=(sub,role)=>signToken({sub,role});
 return {db,id,customer,provider,token:token(customer,'customer'),providerToken:token(provider,'provider'),otherToken:token(customer+999,'customer'),intent:{id:7,order_id:id,amount_cents:107,gateway_ref:'REMOTE-INTENT',status:'requires_payment'}};
}
const get=p=>call(details.GET,{token:p.token,params:{id:String(p.id)}});
const pay=p=>call(simulate.POST,{token:p.token,body:{order_id:p.id}});
function remote(p,state='pending'){
 const calls=[];const paymentsClient={
  getIntentForOrder:async(id)=>{calls.push(['intent',id]);return {...p.intent};},
  simulateSucceeded:async(id)=>{calls.push(['simulate',id]);return {ok:true,replayed:false,settled:true};},
  getWallet:async()=>({provider_id:p.provider,balance_cents:null,commission_owed_cents:null,transactions:[],wallet_setup:'pending'}),
  listCustomerTransactions:async()=>[],
 };
 const config={paymentsClient,credentials:async auth=>{calls.push(['credentials',auth.role,auth.sub]);return {token:'explicit-test-user-token'};},readSetup:()=>state};
 configurePaymentsAccess(config);return{calls,paymentsClient,config};
}
test('payment views and simulation callers',async t=>{
 t.after(()=>{resetPaymentsAccess();resetBookingSaga();});
 await t.test('legacy default keeps original detail/intent and payment behavior',async()=>{
  const p=fixture();const result=await get(p);assert.equal(result.status,200);assert.equal(result.body.payment_intent.gateway_ref,'LOCAL-SENTINEL');assert.equal(result.body.payment_setup,undefined);
  assert.equal((await pay(p)).status,200);
 });
 await t.test('a saga without configured remote access is pending and never falls back to local payment SQL',async()=>{
  const p=fixture(true);p.db.exec('DROP TABLE payment_intents');
  const result=await get(p);assert.equal(result.status,200);assert.equal(result.body.payment_setup,'pending');assert.equal(result.body.payment_intent,undefined);
  assert.equal((await pay(p)).status,503);assert.equal(p.db.prepare('SELECT count(*) AS n FROM slot_holds WHERE order_id=?').get(p.id).n,1);
 });
 await t.test('configured detail and simulation use remote intent while local intent table is absent',async()=>{
  const p=fixture(true), r=remote(p,'ready');p.db.exec('DROP TABLE payment_intents');
  const result=await get(p);assert.equal(result.status,200);assert.equal(result.body.payment_setup,'ready');assert.equal(result.body.payment_intent.gateway_ref,'REMOTE-INTENT');
  assert.equal((await pay(p)).status,200);assert.ok(r.calls.some(([name])=>name==='simulate'));
 });
 await t.test('pending/blocked/reconcile/readiness failure do not permit direct simulated payment',async()=>{
  for(const state of ['pending','blocked','reconcile',null]){
   const p=fixture(true),r=remote(p,state);assert.equal((await get(p)).body.payment_setup,'pending');assert.equal((await pay(p)).status,503);
   assert.equal(r.calls.some(([name])=>name==='simulate'),false);
  }
 });
 await t.test('remote outage, wrong context or failed intent cannot show local intent or ready',async()=>{
  for(const mode of ['outage','missing','amount','failed']){
   const p=fixture(true),r=remote(p,'ready');
   if(mode==='outage'||mode==='missing')r.paymentsClient.getIntentForOrder=async()=>{throw new AppError(mode==='missing'?404:503,'unavailable');};
   if(mode==='amount')p.intent.amount_cents=999;if(mode==='failed')p.intent.status='failed';
   const result=await get(p);assert.equal(result.status,200);assert.equal(result.body.payment_setup,'pending');assert.notEqual(result.body.payment_intent?.gateway_ref,'LOCAL-SENTINEL');
  }
 });
 await t.test('ownership and OTP gates execute before remote calls; provider gets no OTP',async()=>{
  const p=fixture(true),r=remote(p,'ready');assert.equal((await call(details.GET,{token:p.otherToken,params:{id:String(p.id)}})).status,403);assert.equal(r.calls.length,0);
  const provider=await call(details.GET,{token:p.providerToken,params:{id:String(p.id)}});assert.equal(provider.status,200);assert.equal(provider.body.otp,undefined);
  r.calls.length=0;assert.equal((await call(simulate.POST,{token:p.otherToken,body:{order_id:p.id}})).status,403);assert.equal(r.calls.length,0);
  r.paymentsClient.getIntentForOrder=async()=>{throw new AppError(403,'forbidden');};assert.equal((await get(p)).status,403);
 });
 await t.test('cancelled booking cannot be paid even if readiness reader is stale',async()=>{
  const p=fixture(true),r=remote(p,'ready');p.db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(p.id);
  assert.equal((await get(p)).body.payment_setup,'pending');assert.equal((await pay(p)).status,409);assert.equal(r.calls.some(([name])=>name==='simulate'),false);
 });
 await t.test('configured wallet/history use remote pending data without touching local wallets',async()=>{
  const p=fixture(),r=remote(p);p.db.exec('DROP TABLE provider_wallets');
  const response=await call(wallet.GET,{token:p.providerToken});assert.equal(response.status,200);assert.equal(response.body.wallet_setup,'pending');assert.equal(response.body.balance_cents,null);
  assert.deepEqual((await call(history.GET,{token:p.token})).body,[]);
  r.paymentsClient.getWallet=async()=>({provider_id:p.provider+999,balance_cents:0,commission_owed_cents:0,transactions:[]});assert.equal((await call(wallet.GET,{token:p.providerToken})).status,503);
 });
 await t.test('remote access cannot place a new gateway booking through the old SQLite writer',async()=>{
  const p=fixture();remote(p);const before=p.db.prepare('SELECT count(*) AS n FROM orders').get().n;
  const response=await call(bookings.POST,{token:p.token,body:{provider_id:p.provider,service_date:'2026-12-01',starting_time:'10:00',items:[{service_id:2,quantity:1}],payment_method:'gateway'}});
  assert.equal(response.status,503);assert.equal(p.db.prepare('SELECT count(*) AS n FROM orders').get().n,before);
 });
 await t.test('pay widget requires ready for migrated bookings and excludes paid/failed/cancelled states',()=>{
  const initial={order:{payment_method:'gateway',payment_status:'pending',status:'awaiting'},payment_intent:{status:'requires_payment'}};
  assert.equal(canSimulatePayment(initial),true);
  for(const state of ['pending','blocked','reconcile',null])assert.equal(canSimulatePayment({...initial,payment_setup:state}),false);
  assert.equal(canSimulatePayment({...initial,payment_setup:'ready'}),true);
  assert.equal(canSimulatePayment({...initial,order:{...initial.order,status:'cancelled'}}),false);
  assert.equal(canSimulatePayment({...initial,payment_intent:{status:'failed'}}),false);
 });
});
