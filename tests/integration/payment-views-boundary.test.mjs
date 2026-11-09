import {freshBoot,getDb} from '../../bangkok-homeservice/test-helpers/boot.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {call} from '../../bangkok-homeservice/test-helpers/call.js';
import {loginSeededCustomer,loginSeededProvider,futureWeekday} from '../../bangkok-homeservice/test-helpers/auth.js';
import * as bookings from '../../bangkok-homeservice/app/api/bookings/route.js';
import * as detail from '../../bangkok-homeservice/app/api/bookings/[id]/route.js';
import * as simulate from '../../bangkok-homeservice/app/api/payments/simulate/route.js';
import * as wallet from '../../bangkok-homeservice/app/api/provider/wallet/route.js';
import {configurePaymentsAccess,resetPaymentsAccess} from '../../bangkok-homeservice/lib/modules/payments/access.js';
import {configureBookingSaga,resetBookingSaga} from '../../bangkok-homeservice/lib/modules/booking/saga.js';
import {createPaymentsClient} from '../../bangkok-homeservice/lib/modules/payments/client.js';
import {createBookingPaymentsAdapter} from '../../bangkok-homeservice/lib/modules/booking/payment-adapter.js';
import {createDatabase} from '../../services/payments-wallet/src/database.js';
import {migrate} from '../../services/payments-wallet/src/migrations.js';
import {createPaymentsService} from '../../services/payments-wallet/src/service.js';
import {createPaymentParticipant} from '../../services/payments-wallet/src/participant/index.js';
import {createOutbox} from '../../services/payments-wallet/src/messaging/outbox.js';
import {createApp} from '../../services/payments-wallet/src/app.js';
import {HttpError} from '../../services/payments-wallet/src/errors.js';

test('Next callers read remote intents, gate payments and show pending wallets without SQLite payment tables',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 freshBoot();const sqlite=getDb(),db=createDatabase(process.env.TEST_DATABASE_URL),caller='view-e2e|'+randomUUID();let participant,server,orderId;
 const customer=await loginSeededCustomer('nong@example.com'),provider=await loginSeededProvider('sparkle@example.com');
 const hooks={assertSettlementAllowed:(tx,intent)=>participant.assertSettlementAllowed(tx,intent),stageEvent:createOutbox().stage};
 const business=createPaymentsService(db,hooks);participant=createPaymentParticipant({database:db,business});
 // This readiness callback represents C's pending worker interface. It is a deliberate test double;
 // actual client/HTTP/participant/SQLite/PG are real, but #29 recovery is not enabled by this test.
 let readiness='pending',allowActivation=false;
 try{
  await migrate(db);
  server=createApp({database:db,paymentCommands:{...participant,activate:async input=>{
    // Current saga auto-delivers activation. Hold only that fixture boundary so
    // the stale-UI case really tests a created (not already activated) intent.
    if(!allowActivation)throw new HttpError(503,'fixture activation held');
    return participant.activate(input);
   }},paymentHooks:hooks,
   authenticateService:async req=>{if(req.get('authorization')!=='Bearer service-fixture')throw new HttpError(401,'invalid test service');return{service:'booking',callerId:caller};},
   authenticate:async req=>{const token=req.get('authorization');if(token==='Bearer customer-fixture')return{role:'customer',domainId:customer.id};if(token==='Bearer provider-fixture')return{role:'provider',domainId:provider.id};throw new HttpError(401,'invalid test user');},
  }).listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const client=createPaymentsClient({baseUrl:`http://127.0.0.1:${server.address().port}`}),adapter=createBookingPaymentsAdapter({paymentsClient:client});
  configureBookingSaga({payments:adapter,credentials:async()=>({token:'service-fixture'})});
  configurePaymentsAccess({paymentsClient:client,credentials:async auth=>({token:auth.role==='provider'?'provider-fixture':'customer-fixture'}),readSetup:()=>readiness});
  const address=sqlite.prepare('SELECT id FROM addresses WHERE customer_id=? LIMIT 1').get(customer.id).id;
  const created=await call(bookings.POST,{token:customer.token,headers:{'Idempotency-Key':'view-e2e-'+randomUUID()},body:{provider_id:provider.id,address_id:address,service_date:futureWeekday(8),starting_time:'10:00',items:[{service_id:2,quantity:1}],payment_method:'gateway'}});
  assert.equal(created.status,201);orderId=created.body.order.id;assert.equal(created.body.payment_setup,'pending');
  sqlite.exec('DROP TABLE payment_intents; DROP TABLE provider_wallets'); // prove no local fallback
  await t.test('detail reads actual PG intent and pending blocks a direct payment attempt',async()=>{
   const view=await call(detail.GET,{token:customer.token,params:{id:String(orderId)}});assert.equal(view.status,200);assert.equal(view.body.payment_setup,'pending');assert.equal(view.body.payment_intent.id,created.body.payment_intent.id);
   assert.equal((await call(simulate.POST,{token:customer.token,body:{order_id:orderId}})).status,503);
   assert.ok(sqlite.prepare('SELECT count(*) AS n FROM slot_holds WHERE order_id=?').get(orderId).n>0);
  });
  await t.test('stale UI readiness cannot bypass the Payments settlement eligibility guard',async()=>{
   const state=(await db.query('SELECT state FROM payment_provisioning WHERE order_id=$1',[orderId])).rows[0];assert.equal(state.state,'created');
   readiness='ready';assert.equal((await call(simulate.POST,{token:customer.token,body:{order_id:orderId}})).status,503);
   // The transport sanitizes an unhandled read-mutation conflict to unavailable, not success.
   assert.equal((await db.query("SELECT 1 FROM transactions WHERE order_id=$1 AND kind='charge'",[orderId])).rowCount,0);
  });
  await t.test('after actual activation, simulate settles once and detail sees succeeded before paid-event delivery',async()=>{
   allowActivation=true;
   const saga=sqlite.prepare('SELECT * FROM booking_sagas WHERE order_id=?').get(orderId);
   await adapter.activate({createCommandId:saga.create_command_id,sagaId:saga.saga_id,activateCommandId:`activate:${saga.saga_id}`},{token:'service-fixture'});
   const paid=await call(simulate.POST,{token:customer.token,body:{order_id:orderId}});assert.equal(paid.status,200);assert.equal(paid.body.settled,true);
   assert.equal((await call(simulate.POST,{token:customer.token,body:{order_id:orderId}})).status,200);
   assert.equal((await db.query("SELECT count(*)::int AS n FROM transactions WHERE order_id=$1 AND kind='charge'",[orderId])).rows[0].n,1);
   const view=await call(detail.GET,{token:customer.token,params:{id:String(orderId)}});assert.equal(view.body.payment_intent.status,'succeeded');
   assert.equal(sqlite.prepare('SELECT payment_status FROM orders WHERE id=?').get(orderId).payment_status,'pending','paid event is intentionally not consumed in this test');
  });
  await t.test('provider sees no OTP and pending wallet preserves payment history; provisioning then exposes real zero',async()=>{
   const view=await call(detail.GET,{token:provider.token,params:{id:String(orderId)}});assert.equal(view.status,200);assert.equal(view.body.otp,undefined);
   const pending=await call(wallet.GET,{token:provider.token});assert.equal(pending.status,200);assert.equal(pending.body.wallet_setup,'pending');assert.equal(pending.body.balance_cents,null);assert.equal(pending.body.transactions.length,1);
   await business.provisionWallet(provider.id);
   const ready=await call(wallet.GET,{token:provider.token});assert.equal(ready.body.wallet_setup,undefined);assert.equal(ready.body.balance_cents,0);
  });
 }finally{
  resetPaymentsAccess();resetBookingSaga();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  try{await db.query('DELETE FROM payment_commands WHERE caller_id=$1',[caller]);await db.query('DELETE FROM payment_provisioning WHERE caller_id=$1',[caller]);
   if(orderId){await db.query('DELETE FROM outbox_events WHERE aggregate_id=$1',[String(orderId)]);await db.query("DELETE FROM webhook_events WHERE payload_json->>'gateway_ref' IN (SELECT gateway_ref FROM payment_intents WHERE order_id=$1)",[orderId]);await db.query('DELETE FROM transactions WHERE order_id=$1',[orderId]);await db.query('DELETE FROM payment_intents WHERE order_id=$1',[orderId]);await db.query('DELETE FROM provider_wallets WHERE provider_id=$1',[provider.id]);}
  }finally{await db.close();}
 }
});
