// Real B sidecars and A/C composition, with explicit transport fixtures (not Keycloak).
import {freshBoot,getDb} from '../test-helpers/boot.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {configureAuthenticatedServices} from '../lib/runtime/authenticated-services.js';
import {createIdentityMappingStore} from '../lib/security/identity-mapping.js';
import {oidcSessionFixture} from '../test-helpers/oidc-sessions.js';
import {getAuth,signToken} from '../lib/http/auth.js';
import {getIdentityAccess} from '../lib/http/identity-access.js';
import {getPaymentsAccess} from '../lib/modules/payments/access.js';
import {getBookingSaga} from '../lib/modules/booking/saga.js';
import {getBookingFinancialAccess} from '../lib/modules/booking/financial-state.js';
import {getBookingFinalizationRuntime} from '../lib/modules/booking/finalization.js';
import {getWebhookAccess} from '../lib/modules/payments/webhook-access.js';
import {getNotificationsAccess,listNotifications} from '../lib/modules/notifications/access.js';
import {getProviderEventWrites} from '../lib/modules/providers/event-writes.js';
import {getNotificationEventDelivery} from '../lib/modules/notifications/relay.js';
import {POST as webhook} from '../app/api/payments/webhook/route.js';
import {call} from '../test-helpers/call.js';
import {POST as complete} from '../app/api/bookings/[id]/complete/route.js';
import {POST as logout} from '../app/api/auth/logout/route.js';
const issuer='https://id.example.test/realms/homeservice',secret='s'.repeat(32);
freshBoot();
function setup(t){
 const fixture=oidcSessionFixture(t,{secret}),db=getDb();
 const customer=db.prepare('SELECT id FROM customers LIMIT 1').get().id,provider=db.prepare('SELECT id FROM providers LIMIT 1').get().id;
 const bindings=createIdentityMappingStore({path:fixture.path});bindings.provision({issuer,sub:'customer-sub',role:'customer',domainId:customer});bindings.provision({issuer,sub:'provider-sub',role:'provider',domainId:provider});bindings.close();
 const request=(role='customer',aud=['notifications-service','payments-wallet-service'])=>{
  const sub=role+'-sub',domainId=role==='customer'?customer:provider,exp=Math.floor(Date.now()/1000)+300;
  const token='eyJhbGciOiJSUzI1NiJ9.'+Buffer.from(JSON.stringify({iss:issuer,sub,azp:'homeservice-web',aud,exp})).toString('base64url')+'.fixture';
  const id=fixture.issue({issuer,sub,role,domainId,exp,accessToken:token});
  return new Request('https://app.example.test',{headers:{Cookie:'homeservice_oidc_session='+id}});
 };
 let page=request();const calls=[];
 const fetchImpl=async(url,init)=>{
  calls.push({url:String(url),...init});
  if(String(url).endsWith('/token'))return Response.json({access_token:'booking-fixture',token_type:'Bearer',expires_in:300});
  if(String(url).includes('/notifications'))return Response.json([]);
  if(String(url).endsWith('/webhook'))return Response.json({error:'unauthorized'},{status:401});
  throw Error('unexpected fixture request');
 };
 return {customer,provider,calls,request,page:()=>page,setPage:req=>{page=req;},options:{issuer,paymentsUrl:'https://payments.example.test',notificationsUrl:'https://notes.example.test',bookingClientSecret:'fixture-only',sessionSecret:secret,sessionDbPath:fixture.path,identityMappingDbPath:fixture.path,requestProvider:async()=>page,fetchImpl},path:fixture.path};
}
const selected=()=>[getIdentityAccess(),getPaymentsAccess(),getBookingSaga(),getBookingFinancialAccess(),getBookingFinalizationRuntime(),getWebhookAccess(),getNotificationsAccess(),getProviderEventWrites(),getNotificationEventDelivery()];
test('authenticated composition',async t=>{
 await t.test('validates before global mutation and rejects replacement without disturbing active runtime',async t=>{
  const f=setup(t);
  for(const change of [{paymentsUrl:'http://payments.example.test'},{sessionSecret:'short'},{sagaOptions:{unknown:1}},{finalizationOptions:{maxBackoffMs:1,baseBackoffMs:10}},{recoveryIntervalMs:0}]){
   assert.throws(()=>configureAuthenticatedServices({...f.options,...change}));assert.ok(selected().every(x=>x===null));
  }
  const runtime=configureAuthenticatedServices(f.options);
  try{assert.ok(selected().every(Boolean));const refs=selected();assert.throws(()=>configureAuthenticatedServices(f.options),/existing runtimes/);assert.deepEqual(selected(),refs);}
  finally{await runtime.stop();}assert.ok(selected().every(x=>x===null));
 });
 await t.test('same identity for API and page-context clients; legacy/forged actor cannot replace the OIDC user',async t=>{
  const f=setup(t),runtime=configureAuthenticatedServices(f.options);
  try{
   const auth=getAuth(f.page(),'customer');assert.deepEqual({sub:auth.sub,role:auth.role},{sub:f.customer,role:'customer'});assert.ok(auth.email);
   assert.equal(getIdentityAccess().read(f.page()).sub,auth.sub,'Server Component reader uses same identity');
   assert.deepEqual(await listNotifications(auth,f.page()),[]);assert.deepEqual(await listNotifications(auth),[],'requestProvider supplies page credentials without captured browser state');
   await assert.rejects(runtime.userCredentials({sub:f.provider,role:'provider'},f.page()),e=>e.statusCode===403);
   assert.throws(()=>getAuth(new Request('https://app.example.test',{headers:{Authorization:'Bearer '+signToken({sub:f.customer,role:'customer'})}})),e=>e.statusCode===401,'no legacy JWT fallback');
   f.setPage(f.request('provider'));await assert.rejects(runtime.userCredentials(auth),e=>e.statusCode===403,'no previous user cached in page credentials');
   const wrongAudience=f.request('customer','notifications-service');await assert.rejects(runtime.userCredentials(auth,wrongAudience),e=>e.statusCode===401);
  }finally{await runtime.stop();}
 });
 await t.test('mapping removed or changed fails closed before a local Booking mutation',async t=>{
  const f=setup(t),runtime=configureAuthenticatedServices(f.options);
  try{
   const Database=(await import('better-sqlite3')).default,db=new Database(f.path);db.prepare("DELETE FROM keycloak_identity_bindings WHERE subject='customer-sub'").run();db.close();
   assert.throws(()=>getAuth(f.page()),e=>e.statusCode===401);assert.equal(f.calls.length,0);
  }finally{await runtime.stop();}
 });
 await t.test('public webhook forwards original caller bearer; never obtains privileged gateway credentials',async t=>{
  const f=setup(t),runtime=configureAuthenticatedServices(f.options);
  const request=token=>new Request('https://app.example.test/api/payments/webhook',{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify({gateway_event_id:'fixture-event',gateway_ref:'fixture-ref',type:'payment_intent.succeeded'})});
  try{
   assert.equal((await webhook(request())).status,401);assert.equal(f.calls.length,0);
   assert.equal((await webhook(request('untrusted-caller'))).status,401);
   assert.equal(f.calls[0].headers.Authorization,'Bearer untrusted-caller');assert.equal(f.calls.some(c=>c.url.endsWith('/token')),false);
  }finally{await runtime.stop();}
 });
 await t.test('legacy logout URL revokes the configured sidecar session and recovery stop is idempotent',async t=>{
  const f=setup(t),runtime=configureAuthenticatedServices({...f.options,recoveryIntervalMs:10});
  try{
   runtime.startRecovery();runtime.startRecovery();await runtime.recoverNow();
   const request=new Request('https://app.example.test/api/auth/logout',{method:'POST',headers:{Origin:'https://app.example.test',Cookie:f.page().headers.get('cookie')}});
   assert.equal((await logout(request)).status,200);assert.throws(()=>getAuth(f.page()),e=>e.statusCode===401);
  }finally{await runtime.stop();await runtime.stop();}
  assert.ok(selected().every(x=>x===null));assert.throws(()=>runtime.startRecovery(),/stopped/);
 });
 await t.test('recovery coalesces concurrent rounds and stop drains the active financial delivery',async t=>{
  const f=setup(t);let release,enteredResolve,attempts=0;
  const entered=new Promise(r=>{enteredResolve=r;});
  const fetchImpl=async(url,init)=>{
   if(!String(url).endsWith('/internal/booking-completions'))return f.options.fetchImpl(url,init);
   if(++attempts===1)return Response.json({error:'outage'},{status:503});
   enteredResolve();await new Promise(r=>{release=r;});
   const request=JSON.parse(init.body);
   return Response.json({command_id:init.headers['Idempotency-Key'],kind:'completion',request,state:'ready',accounting:{transaction_id:1,kind:'commission_owed',amount_cents:request.commission_cents}});
  };
  const runtime=configureAuthenticatedServices({...f.options,fetchImpl,finalizationOptions:{baseBackoffMs:1,maxBackoffMs:1}});
  try{
   const id=getDb().prepare(`INSERT INTO orders(customer_id,provider_id,service_date,starting_time,ending_time,duration_min,subtotal_cents,tax_cents,total_cents,commission_pct,payment_method,otp,status)
    VALUES(?,?,'2027-06-01','10:00','10:30',30,10000,700,10700,10,'cod',123456,'started')`).run(f.customer,f.provider).lastInsertRowid;
   const result=await call(complete,{headers:{Cookie:f.request('provider').headers.get('cookie')},params:{id:String(id)},body:{otp:123456}});
   assert.equal(result.status,200);assert.equal(result.body.accounting_status,'pending');
   await new Promise(r=>setTimeout(r,5));
   const first=runtime.recoverNow();await entered;
   assert.equal(runtime.recoverNow(),first,'same in-flight round, not a second delivery');
   let stopped=false;const draining=runtime.stop().then(()=>{stopped=true;});
   await new Promise(r=>setTimeout(r,5));assert.equal(stopped,false);
   release();await first;await draining;
   assert.equal(getDb().prepare('SELECT state FROM booking_financial_work WHERE order_id=?').get(id).state,'ready');
   assert.equal(attempts,2);assert.ok(selected().every(x=>x===null));
  }finally{release?.();await runtime.stop();}
 });

});
