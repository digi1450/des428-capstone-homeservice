import {freshBoot,getDb} from '../test-helpers/boot.js';import test from 'node:test';import assert from 'node:assert/strict';
import {call} from '../test-helpers/call.js';import {signToken} from '../lib/http/auth.js';
import * as complete from '../app/api/bookings/[id]/complete/route.js';import * as cancel from '../app/api/bookings/[id]/cancel/route.js';import * as webhook from '../app/api/payments/webhook/route.js';
import * as booking from '../lib/modules/booking/service.js';import * as repo from '../lib/modules/booking/repository.js';
import {configureBookingFinancialAccess,resetBookingFinancialAccess,financialStatus} from '../lib/modules/booking/financial-access.js';
import {configureWebhookAccess,resetWebhookAccess} from '../lib/modules/payments/webhook-access.js';
import {configurePaymentsAccess,resetPaymentsAccess,getWalletView,getTransactionView} from '../lib/modules/payments/access.js';
import {canSimulatePayment} from '../app/_ui/payment-state.js';
function fixture(status='started'){
 resetBookingFinancialAccess();resetWebhookAccess();resetPaymentsAccess();freshBoot();const db=getDb();
 const customer=db.prepare('SELECT id FROM customers ORDER BY id LIMIT 1').get().id,provider=db.prepare('SELECT id FROM providers ORDER BY id LIMIT 1').get().id;
 const id=db.prepare(`INSERT INTO orders(customer_id,provider_id,service_date,starting_time,ending_time,duration_min,subtotal_cents,tax_cents,total_cents,commission_pct,payment_method,otp,status) VALUES (?,?,'2026-12-01','10:00','10:30',30,100,7,107,10,'cod',123456,?)`).run(customer,provider,status).lastInsertRowid;
 db.prepare("INSERT INTO slot_holds(provider_id,service_date,slot_time,order_id) VALUES (?,'2026-12-01','10:00',?)").run(provider,id);
 return{db,id,customer,provider,providerToken:signToken({sub:provider,role:'provider'}),customerToken:signToken({sub:customer,role:'customer'})};
}
function install(p){let state='pending',calls=0,blocked=false;
 const callbacks={
  complete:async({orderId,providerId,otp})=>{
   calls++;p.db.transaction(()=>{if(repo.findOrderById(orderId).status==='started')repo.completeAtomic(orderId,providerId,otp,11,96);})();
   return {...booking.toPublicOrder(repo.findOrderById(orderId)),accounting_status:state}; // C fixture, NOT durable recovery implementation
  },
  cancel:async({orderId,customerId})=>{
   calls++;blocked=state!=='ready';
   if(state==='ready')p.db.transaction(()=>{repo.cancelAtomic(orderId,customerId);repo.deleteSlotHoldsForOrder(orderId);})();
   return{order:booking.toPublicOrder(repo.findOrderById(orderId)),cancellation_status:state,...(state==='ready'?{refunded:false}:{})};
  },
  status:async()=>repo.findOrderById(p.id).status==='completed'?{accounting_status:state}:{cancellation_status:blocked?state:undefined},
  assertTransitionAllowed:()=>{assert.equal(p.db.inTransaction,true,'C local guard must run inside the SQLite mutation transaction');return !blocked;},
 };
 configureBookingFinancialAccess({bookingFinalization:callbacks});return{callbacks,calls:()=>calls,state:value=>{state=value;},block:()=>{blocked=true;}};
}
test('A public financial callers use C ownership seam and fail closed',async t=>{
 t.after(()=>{resetBookingFinancialAccess();resetWebhookAccess();resetPaymentsAccess();});
 await t.test('missing partial C configuration cannot select new mode; remote payments cannot use legacy completion/refund',async()=>{
  const p=fixture();assert.throws(()=>configureBookingFinancialAccess({bookingFinalization:{complete(){}}}),TypeError);
  configurePaymentsAccess({paymentsClient:{getIntentForOrder(){},simulateSucceeded(){},getWallet(){},listCustomerTransactions(){}},credentials:async()=>({token:'fixture'})});
  p.db.exec('DROP TABLE provider_wallets; DROP TABLE transactions');
  assert.equal((await call(complete.POST,{token:p.providerToken,params:{id:String(p.id)},body:{otp:123456}})).status,503);
  assert.equal((await call(cancel.POST,{token:p.customerToken,params:{id:String(p.id)}})).status,503);
  assert.equal(repo.findOrderById(p.id).status,'started');
 });
 await t.test('completed/pending projection uses no moved SQLite table; permission and OTP checks precede C',async()=>{
  const p=fixture(),r=install(p);p.db.exec('DROP TABLE provider_wallets; DROP TABLE transactions; DROP TABLE payment_intents');
  assert.equal((await call(complete.POST,{token:p.customerToken,params:{id:String(p.id)},body:{otp:123456}})).status,403);
  assert.equal((await call(complete.POST,{token:p.providerToken,params:{id:String(p.id)},body:{otp:999999}})).status,409);assert.equal(r.calls(),0);
  const result=await call(complete.POST,{token:p.providerToken,params:{id:String(p.id)},body:{otp:123456}});assert.equal(result.status,200);assert.equal(result.body.accounting_status,'pending');assert.equal(result.body.status,'completed');
  r.state('ready');const replay=await call(complete.POST,{token:p.providerToken,params:{id:String(p.id)},body:{otp:123456}});assert.equal(replay.body.accounting_status,'ready');
  await assert.rejects(getWalletView({sub:p.provider,role:'provider'}),e=>e.statusCode===503);
  assert.throws(()=>booking.completeBooking(p.id,p.provider,123456),e=>e.statusCode===503);
 });
 await t.test('cancel pending/attention retain holds; only confirmed C result releases them',async()=>{
  const p=fixture('confirmed'),r=install(p);p.db.exec('DROP TABLE provider_wallets; DROP TABLE transactions');
  const invoke=()=>call(cancel.POST,{token:p.customerToken,params:{id:String(p.id)},method:'POST'});
  let result=await invoke();assert.equal(result.status,202);assert.equal(result.body.refunded,undefined);assert.equal(p.db.prepare('SELECT count(*) AS n FROM slot_holds WHERE order_id=?').get(p.id).n,1);
  assert.throws(()=>booking.startBooking(p.id,p.provider),e=>e.statusCode===409);assert.equal(repo.findOrderById(p.id).status,'confirmed');
  assert.throws(()=>booking.rescheduleBooking(p.id,{sub:p.customer,role:'customer'},{service_date:'2026-12-02',starting_time:'10:00'}),e=>e.statusCode===409);
  r.state('attention');result=await invoke();assert.equal(result.status,409);assert.equal(repo.findOrderById(p.id).status,'confirmed');
  r.state('ready');result=await invoke();assert.equal(result.status,200);assert.equal(result.body.order.status,'cancelled');assert.equal(result.body.refunded,false);assert.equal(p.db.prepare('SELECT count(*) AS n FROM slot_holds WHERE order_id=?').get(p.id).n,0);
 });
 await t.test('unpersisted/invalid success or invalid status never becomes a false public success',async()=>{
  const p=fixture(),r=install(p);r.callbacks.complete=async()=>({...booking.toPublicOrder(repo.findOrderById(p.id)),status:'completed',commission_cents:11,provider_earnings_cents:96,accounting_status:'ready'});
  assert.equal((await call(complete.POST,{token:p.providerToken,params:{id:String(p.id)},body:{otp:123456}})).status,503);
  r.callbacks.status=async()=>({cancellation_status:'ready'});
  assert.deepEqual(await financialStatus(p.id,{sub:p.customer,role:'customer'}),{cancellation_status:'pending'});
  assert.equal(canSimulatePayment({order:{payment_method:'gateway',status:'confirmed',payment_status:'pending',cancellation_status:'pending'},payment_intent:{status:'requires_payment'},payment_setup:'ready'}),false);
 });
 await t.test('new-mode bodies reject owner/money injection and async local transition guards',async()=>{
  const p=fixture('confirmed'),r=install(p);
  for(const body of [{amount_cents:1},7,true,'value'])assert.equal((await call(cancel.POST,{token:p.customerToken,params:{id:String(p.id)},body})).status,400);
  assert.equal((await call(complete.POST,{token:p.providerToken,params:{id:String(p.id)},body:{otp:123456,provider_id:9}})).status,400);
  r.callbacks.assertTransitionAllowed=async()=>true;assert.throws(()=>booking.startBooking(p.id,p.provider),e=>e.statusCode===503);assert.equal(repo.findOrderById(p.id).status,'confirmed');
 });
 await t.test('remote callback never falls back to legacy shared secret or SQLite settlement',async()=>{
  const p=fixture();install(p);p.db.exec('DROP TABLE payment_intents; DROP TABLE webhook_events');
  const input={gateway_event_id:'fixture-event',gateway_ref:'fixture-ref',type:'payment_intent.succeeded'};
  assert.equal((await call(webhook.POST,{body:input,secret:'legacy-fixture'})).status,503);
  let verified=0;
  configureWebhookAccess({financialClient:{settleWebhook:async(_body,credentials)=>{assert.equal(credentials.token,'verified-gateway-fixture');return{received:true,replayed:true};}},credentials:async()=>{verified++;return{token:'verified-gateway-fixture'};}});
  const response=await call(webhook.POST,{body:input});assert.equal(response.status,200);assert.equal(response.body.replayed,true);assert.equal(verified,1);
  resetBookingFinancialAccess();p.db.exec('DROP TABLE provider_wallets; DROP TABLE transactions');
  await assert.rejects(getWalletView({sub:p.provider,role:'provider'}),e=>e.statusCode===503);
  await assert.rejects(getTransactionView({sub:p.customer,role:'customer'}),e=>e.statusCode===503);
 });
});
