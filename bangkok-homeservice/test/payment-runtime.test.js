import {freshBoot,getDb} from '../test-helpers/boot.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {configureBookingPaymentsRuntime} from '../lib/modules/booking/payment-runtime.js';
import {getBookingSaga,resetBookingSaga} from '../lib/modules/booking/saga.js';
import {getPaymentsAccess,resetPaymentsAccess} from '../lib/modules/payments/access.js';
import {configureSecureBookingPayments} from '../lib/security/booking-payments.js';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function client(){return Object.fromEntries(['createIntent','getOperation','cancelIntent','activateIntent','getIntentForOrder','simulateSucceeded','getWallet','listCustomerTransactions'].map(name=>[name,async()=>{throw new Error('unexpected test call '+name);} ]));}
const options=()=>({paymentsClient:client(),serviceCredentials:async()=>({token:'test-service'}),userCredentials:async()=>({token:'test-user'})});
function pending(){
 freshBoot();
 const db=getDb(),customer=db.prepare('SELECT id FROM customers LIMIT 1').get().id,provider=db.prepare('SELECT id FROM providers LIMIT 1').get().id;
 const order=db.prepare("INSERT INTO orders(customer_id,provider_id,service_date,starting_time,ending_time,duration_min,subtotal_cents,tax_cents,total_cents,commission_pct,payment_method,otp) VALUES (?,?,'2026-12-01','10:00','10:30',30,100,7,107,10,'gateway',1234)").run(customer,provider).lastInsertRowid;
 db.prepare("INSERT INTO booking_sagas(saga_id,order_id,customer_id,request_key,request_digest,state,create_command_id,cancel_command_id,snapshot_json,intent_json) VALUES ('runtime-saga',?,?,'request-fixture','digest','COMPLETED','create:runtime','cancel:runtime','{}','{}')").run(order,customer);
 db.prepare("INSERT INTO booking_saga_activations(saga_id,activate_command_id,state) VALUES ('runtime-saga','activate:runtime-saga','pending')").run();
 return order;
}
test('Booking payment composition',async t=>{
 t.after(()=>{resetBookingSaga();resetPaymentsAccess();});
 await t.test('invalid/incomplete credentials or client cannot partially configure a runtime',()=>{
  resetBookingSaga();resetPaymentsAccess();
  for(const input of [{...options(),userCredentials:null},{...options(),serviceCredentials:null},{...options(),paymentsClient:{}},{...options(),recoveryIntervalMs:0},{...options(),sagaOptions:{payments:{}}}]){
   assert.throws(()=>configureBookingPaymentsRuntime(input));assert.equal(getBookingSaga(),null);assert.equal(getPaymentsAccess(),null);
  }
 });
 await t.test('real readiness and separate credential callbacks share one client; replacement is rejected',async()=>{
  freshBoot();const o=options(),seen=[];o.serviceCredentials=async()=>{seen.push('service');return {token:'service'};};o.userCredentials=async(auth,ctx)=>{seen.push(['user',auth.sub,ctx]);return{token:'user'};};
  const runtime=configureBookingPaymentsRuntime(o);
  try{
   assert.equal(runtime.access.readSetup(999),null);assert.equal(getBookingSaga(),runtime.saga);
   await runtime.saga.credentials();await runtime.access.credentials({sub:7},'context');assert.deepEqual(seen,['service',['user',7,'context']]);
   assert.throws(()=>configureBookingPaymentsRuntime(options()),/already configured/);assert.equal(getBookingSaga(),runtime.saga);
  }finally{await runtime.stop();}
  assert.equal(getBookingSaga(),null);assert.equal(getPaymentsAccess(),null);assert.throws(()=>runtime.startRecovery(),/not active/);
 });
 await t.test('recovery is opt-in, non-overlapping, and stop drains an in-flight C activation',async()=>{
  const order=pending(),o=options();o.recoveryIntervalMs=2;
  let finish,called;const calls=[];const started=new Promise(resolve=>{called=resolve;});
  o.paymentsClient.activateIntent=(input,credentials)=>new Promise(resolve=>{calls.push({input,credentials});finish=()=>resolve({...input,outcome:'activated'});called();});
  const runtime=configureBookingPaymentsRuntime(o);
  try{
   await sleep(10);assert.equal(calls.length,0,'no worker before explicit start');assert.equal(runtime.access.readSetup(order),'pending');
   runtime.startRecovery();runtime.startRecovery();
   await new Promise((resolve,reject)=>{const deadline=setTimeout(()=>reject(new Error('test worker did not start')),1000);started.then(()=>{clearTimeout(deadline);resolve();});});await sleep(10);assert.equal(calls.length,1,'no overlapping rounds');
   const stopping=runtime.stop();await sleep(5);assert.equal(getBookingSaga(),runtime.saga,'configuration retained until delivery drains');
   finish();await stopping;
   assert.equal(calls[0].credentials.commandId,'activate:runtime-saga');assert.equal(calls[0].credentials.token,'test-service');
   assert.equal(getDb().prepare("SELECT state FROM booking_saga_activations WHERE saga_id='runtime-saga'").get().state,'activated');
   assert.equal(getBookingSaga(),null);assert.equal(getPaymentsAccess(),null);await sleep(10);assert.equal(calls.length,1);
  }finally{if(finish)finish();await runtime.stop();}
 });
 await t.test('B secure helper can explicitly configure the combined runtime without fetching a token at boot',async()=>{
  const userCredentials=async()=>({token:'test-user'});
  const runtime=configureSecureBookingPayments({tokenUrl:'http://127.0.0.1:1/token',clientId:'booking',clientSecret:'test-secret',paymentsUrl:'http://127.0.0.1:1',userCredentials});
  try{assert.equal(runtime.access.credentials,userCredentials);assert.equal(typeof runtime.saga.credentials,'function');assert.equal(runtime.access.readSetup(999),null);}finally{await runtime.stop();}
 });
});
