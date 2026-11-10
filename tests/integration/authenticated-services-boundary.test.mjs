// Actual A routes/clients + C workflows + B RS256 verifiers + two owning PG databases.
// Keycloak issuance/JWKS and identity HTTP transport are explicit fixtures; service
// HTTP/PG and monolith SQLite/session/mapping are real. No live TLS/realm/AMQP claim.
import {freshBoot,getDb} from '../../bangkok-homeservice/test-helpers/boot.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configureAuthenticatedServices} from '../../bangkok-homeservice/lib/runtime/authenticated-services.js';
import {createIdentityMappingStore} from '../../bangkok-homeservice/lib/security/identity-mapping.js';
import {createOidcSessionStore} from '../../bangkok-homeservice/lib/security/oidc-session-store.js';
import {getAuth} from '../../bangkok-homeservice/lib/http/auth.js';
import {listNotifications} from '../../bangkok-homeservice/lib/modules/notifications/access.js';
import {getWalletView} from '../../bangkok-homeservice/lib/modules/payments/access.js';
import {call} from '../../bangkok-homeservice/test-helpers/call.js';
import {futureWeekday} from '../../bangkok-homeservice/test-helpers/auth.js';
import * as bookings from '../../bangkok-homeservice/app/api/bookings/route.js';
import * as detail from '../../bangkok-homeservice/app/api/bookings/[id]/route.js';
import * as confirm from '../../bangkok-homeservice/app/api/bookings/[id]/confirm/route.js';
import * as start from '../../bangkok-homeservice/app/api/bookings/[id]/start/route.js';
import * as complete from '../../bangkok-homeservice/app/api/bookings/[id]/complete/route.js';
import * as cancel from '../../bangkok-homeservice/app/api/bookings/[id]/cancel/route.js';
import * as simulate from '../../bangkok-homeservice/app/api/payments/simulate/route.js';
import * as notifications from '../../bangkok-homeservice/app/api/notifications/route.js';
import * as markRead from '../../bangkok-homeservice/app/api/notifications/[id]/read/route.js';
import * as wallet from '../../bangkok-homeservice/app/api/provider/wallet/route.js';
import * as webhook from '../../bangkok-homeservice/app/api/payments/webhook/route.js';
import {createDatabase} from '../../services/payments-wallet/src/database.js';
import {migrate as migratePayments} from '../../services/payments-wallet/src/migrations.js';
import {migrate as migrateNotes} from '../../services/notifications/src/migrations.js';
import {createPaymentsRuntime} from '../../services/payments-wallet/src/runtime.js';
import {createFinancialOperations} from '../../services/payments-wallet/src/financial/index.js';
import {createUserVerifier} from '../../services/payments-wallet/src/security/user-verifier.js';
import {createUserVerifier as notesVerifier} from '../../services/notifications/src/security/user-verifier.js';
import {createBookingServiceVerifier,createGatewayWebhookVerifier} from '../../services/payments-wallet/src/security/booking-verifier.js';
import {createApp as createNotesApp} from '../../services/notifications/src/app.js';
import {createNotificationsService} from '../../services/notifications/src/service.js';
const enabled=!!process.env.TEST_AUTH_PAYMENTS_DATABASE_URL&&!!process.env.TEST_AUTH_NOTIFICATIONS_DATABASE_URL;
test('authenticated A/B/C service composition', {skip:!enabled},async t=>{
 freshBoot();const sqlite=getDb(),pg=createDatabase(process.env.TEST_AUTH_PAYMENTS_DATABASE_URL),notes=createDatabase(process.env.TEST_AUTH_NOTIFICATIONS_DATABASE_URL);
 const directory=mkdtempSync(join(tmpdir(),'homeservice-auth-boundary-')),path=join(directory,'identity-sessions.sqlite');
 let runtime,paymentServer,notesServer,paymentPort=0,pageRequest;
 const stopPayments=async()=>{if(paymentServer){paymentServer.closeAllConnections();await new Promise(r=>paymentServer.close(r));paymentServer=null;}};
 t.after(async()=>{try{if(runtime)await runtime.stop();await stopPayments();if(notesServer){notesServer.closeAllConnections();await new Promise(r=>notesServer.close(r));}}finally{await pg.close();await notes.close();rmSync(directory,{recursive:true,force:true});}});
 await migratePayments(pg);await migrateNotes(notes);
 const customer=sqlite.prepare("SELECT * FROM customers WHERE email='nong@example.com'").get(),provider=sqlite.prepare("SELECT * FROM providers WHERE email='sparkle@example.com'").get();
 const issuer='https://id.example.test/realms/homeservice',secret='s'.repeat(32),bookingSub='booking-'+randomUUID(),gatewaySub='gateway-'+randomUUID();
 const mapping=createIdentityMappingStore({path});mapping.provision({issuer,sub:'customer-sub',role:'customer',domainId:customer.id});mapping.provision({issuer,sub:'provider-sub',role:'provider',domainId:provider.id});mapping.close();
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const jwk={...publicKey.export({format:'jwk'}),alg:'RS256',kid:'signed-fixture',use:'sig'};
 const jwt=(claims)=>{const a=Buffer.from(JSON.stringify({alg:'RS256',kid:jwk.kid})).toString('base64url'),b=Buffer.from(JSON.stringify({iss:issuer,exp:Math.floor(Date.now()/1000)+300,jti:randomUUID(),...claims})).toString('base64url');return a+'.'+b+'.'+sign('RSA-SHA256',Buffer.from(a+'.'+b),privateKey).toString('base64url');};
 const userToken=role=>jwt({sub:role+'-sub',azp:'homeservice-web',aud:['notifications-service','payments-wallet-service'],resource_access:{'notifications-service':{roles:['user:read']},'payments-wallet-service':{roles:['user:read']}}});
 const cookie=role=>{const sessions=createOidcSessionStore({path,secret});try{return 'homeservice_oidc_session='+sessions.create({issuer,sub:role+'-sub',role,domainId:role==='customer'?customer.id:provider.id,exp:Math.floor(Date.now()/1000)+300,accessToken:userToken(role)});}finally{sessions.close();}};
 const customerCookie=cookie('customer'),providerCookie=cookie('provider');
 const request=role=>new Request('https://app.example.test',{headers:{Cookie:role==='provider'?providerCookie:customerCookie}});
 pageRequest=request('customer');
 const resolveIdentity=async input=>{const map=createIdentityMappingStore({path});try{return map.lookup(input);}finally{map.close();}}; // fixture transport, monolith-owned lookup
 const jwks=async()=>Response.json({keys:[jwk]});
 const payments=createPaymentsRuntime({database:pg,createFinancialOperations,
  authenticate:createUserVerifier({issuer,audience:'payments-wallet-service',resolveIdentity,fetchImpl:jwks}),
  authenticateService:createBookingServiceVerifier({issuer,fetchImpl:jwks}),
  authenticateWebhook:createGatewayWebhookVerifier({issuer,fetchImpl:jwks})});
 const listenPayments=async()=>{paymentServer=payments.app.listen(paymentPort,'127.0.0.1');await new Promise(r=>paymentServer.once('listening',r));paymentPort=paymentServer.address().port;};
 await listenPayments();notesServer=createNotesApp({database:notes,authenticate:notesVerifier({issuer,audience:'notifications-service',resolveIdentity,fetchImpl:jwks})}).listen(0,'127.0.0.1');await new Promise(r=>notesServer.once('listening',r));
 let issued=0;const forwarded=[];
 const fetchImpl=async(url,init)=>{
  const target=new URL(url);
  if(target.origin==='https://id.example.test'){
   assert.equal(init.redirect,'error');const data=new URLSearchParams(init.body);assert.equal(data.get('client_id'),'booking-service');assert.equal(data.get('client_secret'),'fixture-secret');issued++;
   return Response.json({token_type:'Bearer',expires_in:1,access_token:jwt({sub:bookingSub,azp:'booking-service',aud:'payments-wallet-service',resource_access:{'payments-wallet-service':{roles:['create','query','cancel','activate','complete_financial','cancel_financial','query_financial'].map(x=>'booking:'+x)}}})});
  }
  const port=target.origin==='https://payments.example.test'?paymentPort:target.origin==='https://notes.example.test'?notesServer.address().port:null;
  assert.ok(port,'only configured service origins');forwarded.push({path:target.pathname,authorization:init.headers.Authorization});
  return fetch('http://127.0.0.1:'+port+target.pathname+target.search,init); // fixture TLS transport only
 };
 runtime=configureAuthenticatedServices({issuer,paymentsUrl:'https://payments.example.test',notificationsUrl:'https://notes.example.test',bookingClientSecret:'fixture-secret',sessionSecret:secret,sessionDbPath:path,identityMappingDbPath:path,requestProvider:async()=>pageRequest,fetchImpl,sagaOptions:{baseBackoffMs:1,maxBackoffMs:1},finalizationOptions:{baseBackoffMs:1,maxBackoffMs:1},recoveryIntervalMs:10});
 const noteService=createNotificationsService(notes);
 const own=await noteService.record({recipientRole:'customer',recipientId:customer.id,type:'fixture',title:'Own',body:'Own inbox'});
 const other=await noteService.record({recipientRole:'customer',recipientId:customer.id+999,type:'fixture',title:'Other',body:'Other inbox'});
 sqlite.exec('DROP TABLE notifications; DROP TABLE payment_intents; DROP TABLE provider_wallets; DROP TABLE transactions; DROP TABLE webhook_events');
 const headers=role=>({Cookie:role==='provider'?providerCookie:customerCookie});
 let created;
 const input=time=>({provider_id:provider.id,address_id:sqlite.prepare('SELECT id FROM addresses WHERE customer_id=? LIMIT 1').get(customer.id).id,service_date:futureWeekday(8),starting_time:time,items:[{service_id:2,quantity:1}],payment_method:'gateway'});
 const place=time=>call(bookings.POST,{headers:{...headers('customer'),'Idempotency-Key':'auth-'+randomUUID()},body:input(time)});
 const order=id=>sqlite.prepare('SELECT * FROM orders WHERE id=?').get(id);
 const holds=id=>sqlite.prepare('SELECT count(*) n FROM slot_holds WHERE order_id=?').get(id).n;
 const ledger=async id=>(await pg.query('SELECT kind FROM transactions WHERE order_id=$1 ORDER BY id',[id])).rows.map(r=>r.kind);
 await t.test('API and page-context Notifications reads use the same mapped user; cross-owner mark-read is refused',async()=>{
  const api=await call(notifications.GET,{headers:headers('customer')});assert.equal(api.status,200);assert.deepEqual(api.body.map(x=>x.id),[own.id]);
  assert.deepEqual((await listNotifications(getAuth(pageRequest))).map(x=>x.id),[own.id]);
  assert.equal((await call(markRead.POST,{headers:headers('customer'),params:{id:String(other.id)},body:{}})).status,403);
  assert.equal((await call(markRead.POST,{headers:headers('customer'),params:{id:String(own.id)},body:{}})).status,200);
 });
 await t.test('gateway placement uses real service JWT verification and C activation with no SQLite payment tables',async()=>{
  const res=await place('10:00');assert.equal(res.status,201);created=res.body;
  assert.equal(created.payment_setup,'pending','POST conservatively preserves its existing response');assert.ok(holds(created.order.id)>0);
  const view=await call(detail.GET,{headers:headers('customer'),params:{id:String(created.order.id)}});assert.equal(view.status,200);assert.equal(view.body.payment_setup,'ready');
  const rows=(await pg.query('SELECT caller_id,state FROM payment_provisioning WHERE order_id=$1',[created.order.id])).rows;
  assert.deepEqual(rows,[{caller_id:issuer+'|'+bookingSub,state:'activated'}]);
 });
 await t.test('provider wallet shows pending through both API and page-context credentials',async()=>{
  pageRequest=request('provider');const actor=getAuth(pageRequest,'provider');
  const result=await call(wallet.GET,{headers:headers('provider')});assert.equal(result.status,200);assert.equal(result.body.wallet_setup,'pending');
  assert.equal((await getWalletView(actor)).wallet_setup,'pending');
 });
 await t.test('user payment and provider OTP completion produce one PG charge/payout through composed callbacks',async()=>{
  assert.equal((await call(simulate.POST,{headers:headers('customer'),body:{order_id:created.order.id}})).status,200);
  assert.equal((await call(confirm.POST,{headers:headers('provider'),params:{id:String(created.order.id)},body:{}})).status,200);
  assert.equal((await call(start.POST,{headers:headers('provider'),params:{id:String(created.order.id)},body:{}})).status,200);
  const finish=()=>call(complete.POST,{headers:headers('provider'),params:{id:String(created.order.id)},body:{otp:created.otp}});
  const result=await finish();assert.equal(result.status,200);assert.equal(result.body.accounting_status,'ready');assert.equal((await finish()).status,200);
  assert.deepEqual(await ledger(created.order.id),['charge','payout_credit']);
  assert.ok((await pg.query("SELECT 1 FROM outbox_events WHERE aggregate_id=$1 AND event_type='payment.succeeded'",[String(created.order.id)])).rowCount>0);
  assert.equal(order(created.order.id).payment_status,'pending','paid-event consumer/AMQP is deliberately not running in this test');
 });
 await t.test('public webhook keeps caller isolation with original bearer and actual gateway verification',async()=>{
  const body={gateway_event_id:'auth-webhook-'+randomUUID(),gateway_ref:created.payment_intent.gateway_ref,type:'payment_intent.succeeded'};
  assert.equal((await call(webhook.POST,{body})).status,401);
  assert.equal((await call(webhook.POST,{body,headers:{Authorization:'Bearer '+userToken('customer')}})).status,401);
  const gateway=jwt({sub:gatewaySub,azp:'mock-gateway-service',aud:'payments-wallet-service',resource_access:{'payments-wallet-service':{roles:['mock-gateway:settle_webhook']}}});
  assert.equal((await call(webhook.POST,{body,headers:{Authorization:'Bearer '+gateway}})).status,200);
  assert.equal(forwarded.at(-1).authorization,'Bearer '+gateway);assert.deepEqual(await ledger(created.order.id),['charge','payout_credit']);
 });
 await t.test('outage cancellation retains holds; autonomous recovery uses stable caller across fresh tokens without a browser request',async()=>{
  const second=await place('13:00');assert.equal(second.status,201);const id=second.body.order.id;
  const reserved=holds(id);assert.ok(reserved>0);
  await stopPayments();const result=await call(cancel.POST,{headers:headers('customer'),params:{id:String(id)},body:{}});
  assert.deepEqual([result.status,result.body.cancellation_status,holds(id)],[202,'pending',reserved]);
  const saved=sqlite.prepare('SELECT command_id FROM booking_financial_work WHERE order_id=?').get(id).command_id;
  pageRequest=null;await listenPayments();runtime.startRecovery();
  for(let i=0;i<100&&order(id).status!=='cancelled';i++)await new Promise(r=>setTimeout(r,20));
  assert.equal(order(id).status,'cancelled');assert.equal(holds(id),0);
  const rows=(await pg.query('SELECT caller_id,command_id,state FROM financial_commands WHERE order_id=$1',[id])).rows;
  assert.deepEqual(rows,[{caller_id:issuer+'|'+bookingSub,command_id:saved,state:'ready'}]);assert.ok(issued>3,'same caller survives separately issued signed tokens');
  assert.deepEqual(await ledger(id),[]);
 });
});
