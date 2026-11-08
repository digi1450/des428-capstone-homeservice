import {freshBoot,getDb} from '../../bangkok-homeservice/test-helpers/boot.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {call} from '../../bangkok-homeservice/test-helpers/call.js';
import {loginSeededCustomer,loginSeededProvider,futureWeekday} from '../../bangkok-homeservice/test-helpers/auth.js';
import * as bookings from '../../bangkok-homeservice/app/api/bookings/route.js';
import * as details from '../../bangkok-homeservice/app/api/bookings/[id]/route.js';
import * as simulate from '../../bangkok-homeservice/app/api/payments/simulate/route.js';
import * as wallet from '../../bangkok-homeservice/app/api/provider/wallet/route.js';
import {configureBookingPaymentsRuntime} from '../../bangkok-homeservice/lib/modules/booking/payment-runtime.js';
import {createPaymentsClient,PaymentOutcomeUnknownError} from '../../bangkok-homeservice/lib/modules/payments/client.js';
import {createDatabase} from '../../services/payments-wallet/src/database.js';
import {migrate} from '../../services/payments-wallet/src/migrations.js';
import {createPaymentsRuntime} from '../../services/payments-wallet/src/runtime.js';
import {HttpError} from '../../services/payments-wallet/src/errors.js';
async function eventually(check){for(let i=0;i<100;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('runtime recovery did not finish');}

test('A/C composed runtime: lost activation reply -> real recovery/readiness -> one charge/outbox',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 freshBoot();const sqlite=getDb(),db=createDatabase(process.env.TEST_DATABASE_URL),caller='composition|'+randomUUID();let http,composition,orderId;
 const customer=await loginSeededCustomer('nong@example.com'),provider=await loginSeededProvider('sparkle@example.com');
 try{
  await migrate(db);
  // B verification/credentials are explicit doubles ONLY in this fixture. No production fallback.
  const runtime=createPaymentsRuntime({database:db,
   authenticateService:async req=>{if(req.get('authorization')!=='Bearer service-fixture')throw new HttpError(401,'test service required');return{service:'booking',callerId:caller};},
   authenticate:async req=>{const token=req.get('authorization');if(token==='Bearer customer-fixture')return{role:'customer',domainId:customer.id};if(token==='Bearer provider-fixture')return{role:'provider',domainId:provider.id};throw new HttpError(401,'test user required');},
  });
  http=runtime.app.listen(0,'127.0.0.1');await new Promise(resolve=>http.once('listening',resolve));
  const client=createPaymentsClient({baseUrl:`http://127.0.0.1:${http.address().port}`}),activationKeys=[],userCalls=[];let loseReply=true;
  const composedClient={...client,activateIntent:async(input,credentials)=>{
   activationKeys.push(credentials.commandId);const result=await client.activateIntent(input,credentials);
   if(loseReply){loseReply=false;throw new PaymentOutcomeUnknownError('activate',input.create_command_id,'timeout');}
   return result;
  }};
  composition=configureBookingPaymentsRuntime({paymentsClient:composedClient,serviceCredentials:async()=>({token:'service-fixture'}),userCredentials:async auth=>{userCalls.push(auth.role);return{token:auth.role==='provider'?'provider-fixture':'customer-fixture',requestId:'composed-payment'};},sagaOptions:{baseBackoffMs:1,maxBackoffMs:2},recoveryIntervalMs:5});
  const input={provider_id:provider.id,address_id:sqlite.prepare('SELECT id FROM addresses WHERE customer_id=? LIMIT 1').get(customer.id).id,service_date:futureWeekday(8),starting_time:'10:00',items:[{service_id:2,quantity:1}],payment_method:'gateway'},key='runtime-request-'+randomUUID();
  const place=()=>call(bookings.POST,{token:customer.token,headers:{'Idempotency-Key':key},body:input});
  const created=await place();assert.equal(created.status,201);orderId=created.body.order.id;
  const view=()=>call(details.GET,{token:customer.token,params:{id:String(orderId)}});
  const pay=()=>call(simulate.POST,{token:customer.token,body:{order_id:orderId}});
  sqlite.exec('DROP TABLE payment_intents; DROP TABLE provider_wallets');
  await t.test('a committed activation with an unconfirmed reply stays pending and keeps slots',async()=>{
   assert.equal(created.body.payment_setup,'pending');assert.equal((await view()).body.payment_setup,'pending');assert.equal((await pay()).status,503);
   assert.ok(sqlite.prepare('SELECT count(*) AS n FROM slot_holds WHERE order_id=?').get(orderId).n>0);assert.equal(activationKeys.length,1,'recovery is not auto-started');
  });
  await t.test('booking retry uses the original order and does not create another intent',async()=>{
   const replay=await place();assert.equal(replay.status,201);assert.equal(replay.body.order.id,orderId);
   assert.equal((await db.query('SELECT 1 FROM payment_intents WHERE order_id=$1',[orderId])).rowCount,1);
  });
  await t.test('the composed worker retries the saved activation key and real C readiness turns ready',async()=>{
   composition.startRecovery();await eventually(()=>composition.access.readSetup(orderId)==='ready');
   assert.equal((await view()).body.payment_setup,'ready');assert.equal(activationKeys.length,2);assert.equal(new Set(activationKeys).size,1);
   assert.equal((await db.query("SELECT 1 FROM payment_commands WHERE caller_id=$1 AND kind='activate'",[caller])).rowCount,1);
  });
  await t.test('actual user callers settle once and the factory stages the event on the owning database',async()=>{
   assert.equal((await pay()).status,200);assert.equal((await pay()).status,200);
   assert.equal((await db.query("SELECT 1 FROM transactions WHERE order_id=$1 AND kind='charge'",[orderId])).rowCount,1);
   const events=await db.query('SELECT headers FROM outbox_events WHERE aggregate_id=$1',[String(orderId)]);assert.equal(events.rowCount,1);assert.equal(events.rows[0].headers['x-request-id'],'composed-payment');
   const detail=await view();assert.equal(detail.body.payment_intent.status,'succeeded');assert.equal(detail.body.payment_status,'pending','paid event consumption is a separate integration boundary');
   const providerWallet=await call(wallet.GET,{token:provider.token});assert.equal(providerWallet.status,200);assert.equal(providerWallet.body.wallet_setup,'pending');assert.ok(userCalls.includes('provider'));assert.ok(userCalls.includes('customer'));
  });
  await t.test('stopping the composition leaves saga-owned reads/payments closed without local fallback',async()=>{
   await composition.stop();assert.equal((await view()).body.payment_setup,'pending');assert.equal((await pay()).status,503);
  });
 }finally{
  if(http){http.closeAllConnections();await new Promise(resolve=>http.close(resolve));}if(composition)await composition.stop();
  try{await db.query('DELETE FROM payment_commands WHERE caller_id=$1',[caller]);await db.query('DELETE FROM payment_provisioning WHERE caller_id=$1',[caller]);
   if(orderId){await db.query('DELETE FROM outbox_events WHERE aggregate_id=$1',[String(orderId)]);await db.query("DELETE FROM webhook_events WHERE payload_json->>'gateway_ref' IN (SELECT gateway_ref FROM payment_intents WHERE order_id=$1)",[orderId]);await db.query('DELETE FROM transactions WHERE order_id=$1',[orderId]);await db.query('DELETE FROM payment_intents WHERE order_id=$1',[orderId]);}
  }finally{await db.close();}
 }
});
