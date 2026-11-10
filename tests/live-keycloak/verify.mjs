// Actual disposable Keycloak26/TLS + compiled Next + real B verifiers, owning PG and RabbitMQ.
// No useful data or shared realm. Evidence records assertions, never cookies/tokens/passwords.
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import https from 'node:https';
import http from 'node:http';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {createDatabase} from '../../services/payments-wallet/src/database.js';
import {migrate as migratePay} from '../../services/payments-wallet/src/migrations.js';
import {migrate as migrateNotes} from '../../services/notifications/src/migrations.js';
import {createPaymentsRuntime} from '../../services/payments-wallet/src/runtime.js';
import {createFinancialOperations} from '../../services/payments-wallet/src/financial/index.js';
import {createUserVerifier} from '../../services/payments-wallet/src/security/user-verifier.js';
import {createUserVerifier as notesVerifier} from '../../services/notifications/src/security/user-verifier.js';
import {createIdentityResolver} from '../../services/payments-wallet/src/security/identity-resolver.js';
import {createBookingServiceVerifier,createGatewayWebhookVerifier} from '../../services/payments-wallet/src/security/booking-verifier.js';
import {createApp as createNotesApp} from '../../services/notifications/src/app.js';
import {createNotificationsService} from '../../services/notifications/src/service.js';
import {createInbox} from '../../services/notifications/src/messaging/inbox.js';
import {startConsumer} from '../../services/notifications/src/messaging/consumer.js';
import {createPublisher} from '../../services/payments-wallet/src/messaging/publisher.js';
import {createWalletInbox,startWalletConsumer} from '../../services/payments-wallet/src/messaging/wallet-consumer.js';
import {relayOnce} from '../../services/payments-wallet/src/messaging/outbox.js';
const require=createRequire(new URL('../../bangkok-homeservice/package.json',import.meta.url));
const directory=mkdtempSync(join(tmpdir(),'live-oidc-'));
const issuer='https://keycloak:8443/realms/homeservice',base='https://127.0.0.1:3443';
const secret='disposable-session-secret-'.repeat(3),resolverSecret='disposable-resolver-secret';
const path=join(directory,'identities.sqlite'),sessionsPath=join(directory,'sessions.sqlite');
const amqpUrl='amqp://fixture:fixture@rabbitmq:5672?frameMax=131072';
process.env.NODE_ENV='production';process.env.DB_PATH=join(directory,'booking.sqlite');
const tls={key:readFileSync('/fixture/key.pem'),cert:readFileSync('/fixture/cert.pem')};
const {bootstrapDb}=await import('../../bangkok-homeservice/lib/db/bootstrap.js');
const {closeDb,getDb}=await import('../../bangkok-homeservice/lib/db/index.js');
const {createIdentityMappingStore}=await import('../../bangkok-homeservice/lib/security/identity-mapping.js');
const {createOidcSessionStore}=await import('../../bangkok-homeservice/lib/security/oidc-session-store.js');
const sqlite=bootstrapDb(),customers=sqlite.prepare('SELECT id FROM customers ORDER BY id LIMIT 2').all();
assert.equal(customers.length,2);
const provider=sqlite.prepare("SELECT id FROM providers WHERE email='sparkle@example.com'").get().id;
const address=sqlite.prepare('SELECT id FROM addresses WHERE customer_id=? LIMIT 1').get(customers[0].id).id;
const binding=createIdentityMappingStore({path});
for(const [number,role,id]of [[1,'customer',customers[0].id],[2,'customer',customers[1].id],[3,'provider',provider]])binding.provision({issuer,sub:`11111111-1111-4111-8111-${String(number).padStart(12,'0')}`,role,domainId:id});
binding.close();closeDb();
const pay=createDatabase('postgres://fixture:fixture@payments-db:5432/payments'),notes=createDatabase('postgres://fixture:fixture@notifications-db:5432/notifications');
let next,logs='',consumer,walletConsumer,publisher,payServer,notesServer,proxy;
const assertions=[];
const pass=name=>{assertions.push(name);console.log('PASS '+name);};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(predicate,message,attempts=100){for(let n=0;n<attempts;n++){if(await predicate())return;await delay(200);}throw Error('Deadline: '+message);}
const listen=(server,port)=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'0.0.0.0',()=>{server.removeListener('error',reject);resolve();});});
const close=async server=>{if(server?.listening){server.closeAllConnections?.();await new Promise(r=>server.close(r));}};
const jar=()=>new Map();
function cookieHeader(cookies,url){return [...(cookies.get(new URL(url).hostname)||new Map())].map(([k,v])=>k+'='+v).join('; ');}
async function browse(cookies,url,options={}){
 const target=new URL(url);assert.ok([base,'https://keycloak:8443'].includes(target.origin),'browser only visits explicit trusted origins');
 const response=await fetch(url,{redirect:'manual',...options,headers:{...options.headers,Cookie:cookieHeader(cookies,url)}});
 const host=target.hostname,values=cookies.get(host)||new Map();
 for(const cookie of response.headers.getSetCookie()){const pair=cookie.split(';')[0],split=pair.indexOf('=');if(split>0){const name=pair.slice(0,split),value=pair.slice(split+1);if(value)values.set(name,value);else values.delete(name);}}
 cookies.set(host,values);return response;
}
const decode=token=>JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString());
async function login(name){
 const cookies=jar();let response=await browse(cookies,base+'/api/auth/keycloak/start');assert.equal(response.status,302,response.status===503?await response.clone().text():'start redirect');
 const authUrl=response.headers.get('location');assert.ok(authUrl.startsWith(issuer+'/protocol/openid-connect/auth?'));
 assert.equal(new URL(authUrl).searchParams.get('code_challenge_method'),'S256');
 response=await browse(cookies,authUrl);assert.equal(response.status,200);
 const page=await response.text(),form=page.match(/<form[^>]*id="kc-form-login"[^>]*>/)?.[0];assert.ok(form,'real Keycloak credential form');
 const action=form.match(/action="([^"]+)"/)?.[1].replaceAll('&amp;','&');assert.ok(action);
 response=await browse(cookies,action,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:name,password:'Disposable-password-1!',credentialId:''})});
 assert.equal(response.status,302,'real Keycloak authorization code redirect');
 const callback=response.headers.get('location');assert.ok(callback.startsWith(base+'/api/auth/keycloak/callback?'));
 response=await browse(cookies,callback);return {cookies,response,callback};
}
async function registerProvider(){
 const cookies=jar();let response=await browse(cookies,base+'/api/auth/keycloak/start?signup=1');assert.equal(response.status,302);
 response=await browse(cookies,response.headers.get('location'));assert.equal(response.status,200);
 const html=await response.text(),form=html.match(/<form[^>]*id="kc-register-form"[^>]*>/)?.[0];assert.ok(form,'real Keycloak registration form');
 const action=form.match(/action="([^"]+)"/)?.[1].replaceAll('&amp;','&');assert.ok(action);
 const username='new-provider-'+randomUUID().slice(0,8);
 response=await browse(cookies,action,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username,email:username+'@example.test',firstName:'New',lastName:'Provider',password:'Disposable-password-1!','password-confirm':'Disposable-password-1!'})});
 assert.equal(response.status,302,'registration produces real authorization code');
 response=await browse(cookies,response.headers.get('location'));assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/onboarding');
 assert.equal((await api(cookies,'/api/auth/keycloak/profile',{role:'provider',name:'New Provider',company_name:'Live Fixture'},{Origin:base})).status,201);
 const me=await api(cookies,'/api/me');assert.equal(me.body.role,'provider');assert.equal(me.body.profile.is_approved,0);
 await until(async()=>{const value=await api(cookies,'/api/provider/wallet');return value.status===200&&value.body.wallet_setup!=='pending'&&value.body.balance_cents===0;},'provider.registered wallet provisioning through broker');
 const wallet=await api(cookies,'/api/provider/wallet');assert.equal(wallet.status,200);assert.equal(wallet.body.balance_cents,0);
 return cookies;
}

function session(cookies){const store=createOidcSessionStore({path:sessionsPath,secret});try{return store.get(cookies.get('127.0.0.1').get('homeservice_oidc_session'));}finally{store.close();}}
async function serviceToken(client){const r=await fetch(issuer+'/protocol/openid-connect/token',{method:'POST',redirect:'error',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:client,client_secret:'disposable-'+client})});assert.equal(r.status,200);return (await r.json()).access_token;}
const api=async(cookies,path,body,extra={})=>{const r=await browse(cookies,base+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};};
const direct=async(url,token,body,extra={})=>{const r=await fetch(url,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,...extra,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};};
try{
 await until(async()=>{try{return (await fetch(issuer+'/.well-known/openid-configuration')).ok;}catch{return false;}},'Keycloak TLS/realm import',150);
 pass('real Keycloak26 discovery over verified TLS');
 await migratePay(pay);await migrateNotes(notes);
 const resolveIdentity=createIdentityResolver({url:base+'/api/internal/identity/resolve',token:resolverSecret});
 const runtime=createPaymentsRuntime({database:pay,createFinancialOperations,authenticate:createUserVerifier({issuer,audience:'payments-wallet-service',resolveIdentity}),authenticateService:createBookingServiceVerifier({issuer}),authenticateWebhook:createGatewayWebhookVerifier({issuer})});
 payServer=https.createServer(tls,runtime.app);notesServer=https.createServer(tls,createNotesApp({database:notes,authenticate:notesVerifier({issuer,audience:'notifications-service',resolveIdentity})}));
 await listen(payServer,3444);await listen(notesServer,3445);
 consumer=await startConsumer({amqpUrl,inbox:createInbox(notes)});
 walletConsumer=await startWalletConsumer({amqpUrl,inbox:createWalletInbox(pay,runtime.business)});
 publisher=await createPublisher(amqpUrl);
 proxy=https.createServer(tls,(req,res)=>{
  const upstream=http.request({host:'127.0.0.1',port:3199,path:req.url,method:req.method,headers:{...req.headers,'x-forwarded-host':'127.0.0.1:3443','x-forwarded-proto':'https'}},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
  upstream.on('error',()=>{res.writeHead(503);res.end();});req.pipe(upstream);
 });await listen(proxy,3443);
 const launch=()=>{
  const c=spawn(process.execPath,[require.resolve('next/dist/bin/next'),'start','-H','127.0.0.1','-p','3199'],{cwd:new URL('../../bangkok-homeservice',import.meta.url),env:{...process.env,NEXT_RUNTIME:'nodejs',AUTHENTICATED_SERVICES_ENABLED:'true',AUTHENTICATED_CUTOVER_APPROVED:'true',OIDC_LOGIN_ENABLED:'true',OIDC_SELF_REGISTRATION_ENABLED:'true',AREA_B_NOTIFICATIONS_PROXY:'false',AREA_B_PAYMENTS_PROXY:'false',KEYCLOAK_ISSUER:issuer,PAYMENTS_WALLET_SERVICE_URL:'https://127.0.0.1:3444',NOTIFICATIONS_SERVICE_URL:'https://127.0.0.1:3445',BOOKING_SERVICE_CLIENT_SECRET:'disposable-booking-service',OIDC_SESSION_SECRET:secret,IDENTITY_MAPPING_DB_PATH:path,OIDC_SESSION_DB_PATH:sessionsPath,IDENTITY_RESOLVER_TOKEN:resolverSecret,OIDC_REDIRECT_URI:base+'/api/auth/keycloak/callback',AMQP_URL:amqpUrl},stdio:['ignore','pipe','pipe']});
  c.stdout.on('data',x=>{logs+=x});c.stderr.on('data',x=>{logs+=x});return c;
 };next=launch();
 await until(async()=>{if(next.exitCode!==null)throw Error('Next startup exited');return (await fetch(base+'/api/health')).ok;},'Next HTTPS proxy');
 const alice=await login('alice'),bob=await login('bob'),pro=await login('provider');
 for(const user of [alice,bob,pro])assert.equal(user.response.status,303,'callback verifies real signed ID token and nonce');
 const aliceSession=session(alice.cookies),bobSession=session(bob.cookies),proSession=session(pro.cookies);
 assert.equal(decode(aliceSession.accessToken).iss,issuer);assert.equal(decode(aliceSession.accessToken).azp,'homeservice-web');
 assert.equal((await api(alice.cookies,'/api/me')).body.id,customers[0].id);
 assert.equal((await api(bob.cookies,'/api/me')).body.id,customers[1].id);
 pass('real authorization-code PKCE login, signed ID token, issuer/sub mapping for two customers and provider');
 const unbound=await login('unmapped');assert.equal(unbound.response.status,303);assert.equal(unbound.response.headers.get('location'),'/onboarding');assert.equal(session(unbound.cookies),null);
 assert.equal((await api(unbound.cookies,'/api/me')).status,401);
 assert.equal((await browse(unbound.cookies,base+'/onboarding')).status,200);
 assert.equal((await api(unbound.cookies,'/api/auth/keycloak/profile',{role:'admin',name:'Forged'},{Origin:base})).status,400);
 assert.equal((await api(unbound.cookies,'/api/auth/keycloak/profile',{role:'customer',name:'Unbound'},{Origin:'https://evil.example.test'})).status,403);
 assert.equal((await api(unbound.cookies,'/api/auth/keycloak/profile',{role:'customer',name:'Unbound'},{Origin:base})).status,201);
 assert.equal((await api(unbound.cookies,'/api/me')).body.role,'customer');
 pass('unmapped real user is confined to onboarding, admin/CSRF rejected and new customer profile bound once');
 const service=createNotificationsService(notes),own=await service.record({recipientRole:'customer',recipientId:customers[0].id,type:'live',title:'Alice',body:'Live own inbox'}),other=await service.record({recipientRole:'customer',recipientId:customers[1].id,type:'live',title:'Bob',body:'Other inbox'});
 const visible=(await api(alice.cookies,'/api/notifications')).body.map(x=>x.id);assert.ok(visible.includes(own.id));assert.ok(!visible.includes(other.id));
 assert.equal((await api(alice.cookies,`/api/notifications/${other.id}/read`,{})).status,403);
 assert.equal((await direct('https://127.0.0.1:3445/api/notifications',aliceSession.accessToken)).status,200);
 assert.equal((await api(pro.cookies,'/api/provider/wallet')).body.wallet_setup,'pending');
 const page=await browse(pro.cookies,base+'/provider/wallet');assert.equal(page.status,200);assert.match(await page.text(),/Your wallet is being prepared/);
 const spoofed=await direct('https://127.0.0.1:3445/api/notifications',aliceSession.accessToken,undefined,{'X-User-Id':String(customers[1].id),'X-User-Role':'admin'});
 assert.ok(spoofed.body.some(x=>x.id===own.id));assert.ok(!spoofed.body.some(x=>x.id===other.id));
 const parts=aliceSession.accessToken.split('.'),forged=decode(aliceSession.accessToken);forged.sub=bobSession.sub;
 assert.equal((await direct('https://127.0.0.1:3445/api/notifications',parts[0]+'.'+Buffer.from(JSON.stringify(forged)).toString('base64url')+'.'+parts[2])).status,401);
 pass('real user JWT verified by both services, protected HTTPS mapping resolver, ownership/BOLA and actual wallet RSC');
 const oldId=alice.cookies.get('127.0.0.1').get('homeservice_oidc_session');
 assert.equal((await api(alice.cookies,'/api/auth/keycloak/refresh',{}, {Origin:base})).status,200);
 assert.notEqual(alice.cookies.get('127.0.0.1').get('homeservice_oidc_session'),oldId);
 const reused=await fetch(issuer+'/protocol/openid-connect/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:'homeservice-web',refresh_token:aliceSession.refreshToken})});assert.equal(reused.status,400,'realm rejects reuse of rotated refresh credential');
 const stale=jar();stale.set('127.0.0.1',new Map([['homeservice_oidc_session',oldId]]));
 assert.equal((await api(stale,'/api/auth/keycloak/refresh',{}, {Origin:base})).status,401);
 assert.equal((await api(alice.cookies,'/api/me')).status,200);
 pass('real refresh ID-token/nonce verification, atomic opaque-session rotation and stale-session replay rejection');
 await registerProvider();pass('real Keycloak self-registration, provider-only onboarding and durable RabbitMQ wallet provisioning');
 const booking=await serviceToken('booking-service'),gateway=await serviceToken('mock-gateway-service');
 const query='https://127.0.0.1:3444/internal/payment-operations/'+randomUUID();
 assert.equal((await direct(query,booking)).status,404);assert.equal((await direct(query,gateway)).status,401);assert.equal((await direct(query,aliceSession.accessToken)).status,401);
 pass('real Booking/Gateway client-credential role isolation on actual internal API');
 const date=new Date(Date.now()+8*86400000);while(date.getUTCDay()===0)date.setUTCDate(date.getUTCDate()+1);
 const place=async time=>api(alice.cookies,'/api/bookings',{provider_id:provider,address_id:address,service_date:date.toISOString().slice(0,10),starting_time:time,items:[{service_id:2,quantity:1}],payment_method:'gateway'},{'Idempotency-Key':'live-'+randomUUID()});
 const created=await place('10:00');assert.equal(created.status,201);const id=created.body.order.id;
 await until(async()=>((await api(alice.cookies,`/api/bookings/${id}`)).body.payment_setup==='ready'),'real Booking service create/activation');
 const event={gateway_event_id:'live-'+randomUUID(),gateway_ref:created.body.payment_intent.gateway_ref,type:'payment_intent.succeeded'};
 assert.equal((await api(jar(),'/api/payments/webhook',event)).status,401);
 assert.equal((await api(jar(),'/api/payments/webhook',event,{Authorization:'Bearer '+booking})).status,401);
 assert.equal((await api(jar(),'/api/payments/webhook',event,{Authorization:'Bearer '+aliceSession.accessToken})).status,401);
 assert.equal((await api(jar(),'/api/payments/webhook',event,{Authorization:'Bearer '+gateway})).status,200);
 assert.equal((await api(jar(),'/api/payments/webhook',event,{Authorization:'Bearer '+gateway})).status,200);
 await relayOnce({database:pay,publisher,owner:'live-keycloak-fixture'});
 await until(async()=>((await api(alice.cookies,`/api/bookings/${id}`)).body.payment_status==='paid'),'paid event consumed through RabbitMQ');
 assert.equal((await api(bob.cookies,`/api/bookings/${id}`)).status,403);
 assert.equal((await api(pro.cookies,`/api/bookings/${id}/confirm`,{})).status,200);
 assert.equal((await api(pro.cookies,`/api/bookings/${id}/start`,{})).status,200);
 const completed=await api(pro.cookies,`/api/bookings/${id}/complete`,{otp:created.body.otp});assert.equal(completed.status,200);assert.equal(completed.body.accounting_status,'ready');
 assert.equal((await api(pro.cookies,`/api/bookings/${id}/complete`,{otp:created.body.otp})).status,200);
 assert.deepEqual((await pay.query('SELECT kind FROM transactions WHERE order_id=$1 ORDER BY id',[id])).rows.map(x=>x.kind),['charge','payout_credit']);
 pass('real Booking JWT create/activate, gateway-only webhook/replay, RabbitMQ paid event, BOLA and OTP financial completion exactly once');
 const refundable=await place('13:00');assert.equal(refundable.status,201);const refundId=refundable.body.order.id;
 await until(async()=>((await api(alice.cookies,`/api/bookings/${refundId}`)).body.payment_setup==='ready'),'refund booking activation');
 const refundEvent={gateway_event_id:'refund-'+randomUUID(),gateway_ref:refundable.body.payment_intent.gateway_ref,type:'payment_intent.succeeded'};
 assert.equal((await api(jar(),'/api/payments/webhook',refundEvent,{Authorization:'Bearer '+gateway})).status,200);
 await relayOnce({database:pay,publisher,owner:'live-keycloak-refund'});
 await until(async()=>((await api(alice.cookies,`/api/bookings/${refundId}`)).body.payment_status==='paid'),'refund charge paid event');
 assert.equal((await api(alice.cookies,`/api/bookings/${refundId}/cancel`,{})).status,200);
 assert.equal((await api(alice.cookies,`/api/bookings/${refundId}/cancel`,{})).status,200);
 assert.deepEqual((await pay.query('SELECT kind FROM transactions WHERE order_id=$1 ORDER BY id',[refundId])).rows.map(x=>x.kind),['charge','refund']);
 pass('real authenticated cancellation/refund replay produces one refund and no payout');
 const recoverable=await place('16:00');assert.equal(recoverable.status,201);const recoveryId=recoverable.body.order.id;
 const holds=()=>{try{return getDb().prepare('SELECT count(*) n FROM slot_holds WHERE order_id=?').get(recoveryId).n;}finally{closeDb();}};
 const held=holds();assert.ok(held>0);await close(payServer);
 const pending=await api(alice.cookies,`/api/bookings/${recoveryId}/cancel`,{});assert.equal(pending.status,202);assert.equal(pending.body.cancellation_status,'pending');assert.equal(holds(),held);
 next.kill('SIGTERM');await once(next,'exit');next=launch();
 await until(async()=>{try{return (await api(alice.cookies,'/api/me')).status===200;}catch{return false;}},'Next restart preserves useful fixture data and sessions');
 assert.equal(holds(),held,'restart must not release holds while Payments outcome remains unknown');
 await listen(payServer,3444);
 await until(async()=>((await api(alice.cookies,`/api/bookings/${recoveryId}`)).body.status==='cancelled'),'autonomous real-auth cancellation recovery after restart');
 assert.equal(holds(),0);const commands=(await pay.query('SELECT caller_id,state FROM financial_commands WHERE order_id=$1',[recoveryId])).rows;
 assert.deepEqual(commands,[{caller_id:issuer+'|'+decode(booking).sub,state:'ready'}]);
 pass('Payments outage preserves holds; restarted Next recovers with stable real service identity without browser context');
 assert.equal((await api(alice.cookies,`/api/bookings/${id}`)).body.status,'completed');
 assert.equal((await api(alice.cookies,'/api/auth/logout',{}, {Origin:base})).status,200);assert.equal((await api(alice.cookies,'/api/me')).status,401);
 pass('real Next restart preserves mapping/session/booking and logout invalidates application session');
 console.log(JSON.stringify({status:'passed',assertions:assertions.length,keycloak:'26.4.0',limits:['HTTP cookie-jar driver, not a graphical browser','disposable realm/users/data; no final deployment or historical cutover','no historical account migration or full D/E acceptance']}));
}catch(error){
 // Do not dump server logs/callback URLs/token payloads on failure.
 console.error('Live acceptance failed:',error?.message);throw error;
}finally{
 if(next?.exitCode===null){next.kill('SIGTERM');await once(next,'exit');}
 await consumer?.close();await walletConsumer?.close();await publisher?.close();await close(proxy);await close(payServer);await close(notesServer);await pay.close();await notes.close();rmSync(directory,{recursive:true,force:true});
}
