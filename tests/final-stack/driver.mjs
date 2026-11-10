// Runs inside the existing Notifications container: actual 16-service deployment only.
// Host runner supplies `fixture` and `phase` on stdin. Never print tokens/cookies/secrets.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const issuer='https://id.homeservice.test:18443/realms/homeservice';
const base='https://app.homeservice.test:18444';
const statePath='/tmp/final-stack-acceptance.json';
const state=phase==='prepare'?{}:JSON.parse(readFileSync(statePath,'utf8'));
const pass=name=>console.log('PASS '+name);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,name){for(let n=0;n<150;n++){try{if(await check())return;}catch{}await delay(400);}throw Error('Deadline: '+name);}
function save(){writeFileSync(statePath,JSON.stringify(state),{mode:0o600});}
function loadJar(name){return new Map(state[name].map(([host,values])=>[host,new Map(values)]));}
function keepJar(name,cookies){state[name]=[...cookies].map(([host,values])=>[host,[...values]]);}
const jar=()=>new Map();
function cookieHeader(cookies,url){return [...(cookies.get(new URL(url).hostname)||new Map())].map(([k,v])=>k+'='+v).join('; ');}
async function browse(cookies,url,options={}){
 const target=new URL(url);assert.ok([base,'https://id.homeservice.test:18443'].includes(target.origin),'browser only visits explicit trusted origins');
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
 response=await browse(cookies,action,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:name,password:fixture.password,credentialId:''})});
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
 response=await browse(cookies,action,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username,email:username+'@example.test',firstName:'New',lastName:'Provider',password:fixture.password,'password-confirm':fixture.password})});
 assert.equal(response.status,302,'registration produces real authorization code');
 response=await browse(cookies,response.headers.get('location'));assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/onboarding');
 assert.equal((await api(cookies,'/api/auth/keycloak/profile',{role:'provider',name:'New Provider',company_name:'Live Fixture'},{Origin:base})).status,201);
 const me=await api(cookies,'/api/me');assert.equal(me.body.role,'provider');assert.equal(me.body.profile.is_approved,0);
 await until(async()=>{const value=await api(cookies,'/api/provider/wallet');return value.status===200&&value.body.wallet_setup!=='pending'&&value.body.balance_cents===0;},'provider.registered wallet provisioning through broker');
 const wallet=await api(cookies,'/api/provider/wallet');assert.equal(wallet.status,200);assert.equal(wallet.body.balance_cents,0);
 return cookies;
}


const api=async(cookies,path,body,extra={})=>{const r=await browse(cookies,base+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};};
async function serviceToken(client,secret){const r=await fetch(issuer+'/protocol/openid-connect/token',{method:'POST',redirect:'error',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:client,client_secret:secret})});assert.equal(r.status,200);return (await r.json()).access_token;}
const gateway=()=>serviceToken('mock-gateway-service',fixture.gatewaySecret);
if(phase==='prepare'){
 const response=await fetch('https://id.homeservice.test:18443/realms/master/protocol/openid-connect/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'admin-cli',username:'admin',password:fixture.adminSecret})});
 assert.equal(response.status,200);const token=(await response.json()).access_token;const users=[];
 for(const name of ['alice','bob','provider']){
  const result=await fetch('https://id.homeservice.test:18443/admin/realms/homeservice/users',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({username:'acceptance-'+name,enabled:true,email:name+'@acceptance.test',emailVerified:true,firstName:'Acceptance',lastName:name,credentials:[{type:'password',value:fixture.password,temporary:false}]})});
  assert.equal(result.status,201);users.push({name,sub:result.headers.get('location').split('/').at(-1)});
 }
 save();console.log(JSON.stringify(users));
}else if(phase==='auth'){
 for(const name of ['alice','bob','provider']){const user=await login('acceptance-'+name);assert.equal(user.response.status,303);keepJar(name,user.cookies);}
 const alice=loadJar('alice'),pro=loadJar('provider');
 assert.equal((await api(alice,'/api/me')).body.id,fixture.customerId);
 assert.equal((await api(pro,'/api/me')).body.id,fixture.providerId);
 assert.equal((await api(jar(),'/api/me')).status,401);
 assert.equal((await api(alice,'/api/auth/customer/login',{email:'nong@example.com',password:'unused'})).status,409);
 const oldId=alice.get('app.homeservice.test').get('homeservice_oidc_session');
 assert.equal((await api(alice,'/api/auth/keycloak/refresh',{}, {Origin:base})).status,200);
 assert.notEqual(alice.get('app.homeservice.test').get('homeservice_oidc_session'),oldId);
 const stale=jar();stale.set('app.homeservice.test',new Map([['homeservice_oidc_session',oldId]]));
 const replay=await browse(stale,base+'/api/auth/keycloak/refresh',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:'{}'});assert.equal(replay.status,401);assert.equal(replay.headers.getSetCookie().length,0);
 keepJar('alice',alice);pass('actual TLS ingress + real PKCE login/issuer-sub mapping + refresh/replay + unauthenticated denial');
 const newProvider=await registerProvider();keepJar('newProvider',newProvider);
 assert.equal((await api(newProvider,'/api/notifications')).status,200);
 assert.equal((await browse(pro,base+'/provider/wallet')).status,200);
 pass('real Keycloak registration + provider profile + RabbitMQ wallet provisioning + both protected services');
 const booking=await serviceToken('booking-service',fixture.bookingSecret);const denied=await fetch('https://payments.homeservice.test:18446/internal/payment-operations/'+randomUUID(),{headers:{Authorization:'Bearer '+await gateway()}});assert.equal(denied.status,401);
 const allowed=await fetch('https://payments.homeservice.test:18446/internal/payment-operations/'+randomUUID(),{headers:{Authorization:'Bearer '+booking}});assert.equal(allowed.status,404);
 assert.equal((await fetch('https://payments.homeservice.test:18444/internal/payment-operations/missing')).status,404);
 pass('private internal routes + real Booking/Gateway token isolation');save();
}else{
 const alice=loadJar('alice'),bob=loadJar('bob'),pro=loadJar('provider');
 const date=new Date(Date.now()+8*86400000);while(date.getUTCDay()===0)date.setUTCDate(date.getUTCDate()+1);
 const place=async time=>api(alice,'/api/bookings',{provider_id:fixture.providerId,address_id:fixture.addressId,service_date:date.toISOString().slice(0,10),starting_time:time,items:[{service_id:2,quantity:1}],payment_method:'gateway'},{'Idempotency-Key':'final-'+randomUUID()});
 if(phase==='business'){
  const created=await place('10:00');assert.equal(created.status,201,'booking creation');state.completedId=created.body.order.id;const id=state.completedId;
  await until(async()=>((await api(alice,`/api/bookings/${id}`)).body.payment_setup==='ready'),'activation');
  const event={gateway_event_id:'final-'+randomUUID(),gateway_ref:created.body.payment_intent.gateway_ref,type:'payment_intent.succeeded'};
  assert.equal((await api(jar(),'/api/payments/webhook',event)).status,401);
  state.traceId=randomUUID().replaceAll('-','');const headers={Authorization:'Bearer '+await gateway(),traceparent:'00-'+state.traceId+'-1234567890abcdef-01'};
  assert.equal((await api(jar(),'/api/payments/webhook',event,headers)).status,200);
  assert.equal((await api(jar(),'/api/payments/webhook',event,headers)).status,200);
  await until(async()=>((await api(alice,`/api/bookings/${id}`)).body.payment_status==='paid'),'automatic relay and paid consumer');
  assert.equal((await api(bob,`/api/bookings/${id}`)).status,403);
  assert.equal((await api(pro,`/api/bookings/${id}/confirm`,{})).status,200);
  assert.equal((await api(pro,`/api/bookings/${id}/start`,{})).status,200);
  const completed=await api(pro,`/api/bookings/${id}/complete`,{otp:created.body.otp});assert.equal(completed.status,200);assert.equal(completed.body.accounting_status,'ready');
  assert.equal((await api(pro,`/api/bookings/${id}/complete`,{otp:created.body.otp})).status,200);
  await until(async()=>{const reply=await api(alice,'/api/notifications');return reply.status===200&&reply.body.length>0;},'actual notification delivery');
  pass('real separate-process booking/activation + webhook replay + paid event + BOLA + OTP completion + notification');
  const refund=await place('13:00');assert.equal(refund.status,201);state.refundId=refund.body.order.id;
  await until(async()=>((await api(alice,`/api/bookings/${state.refundId}`)).body.payment_setup==='ready'),'refund activation');
  const event2={gateway_event_id:'refund-'+randomUUID(),gateway_ref:refund.body.payment_intent.gateway_ref,type:'payment_intent.succeeded'};
  assert.equal((await api(jar(),'/api/payments/webhook',event2,{Authorization:'Bearer '+await gateway()})).status,200);
  await until(async()=>((await api(alice,`/api/bookings/${state.refundId}`)).body.payment_status==='paid'),'refund paid event');
  assert.equal((await api(alice,`/api/bookings/${state.refundId}/cancel`,{})).status,200);
  assert.equal((await api(alice,`/api/bookings/${state.refundId}/cancel`,{})).status,200);
  pass('authenticated paid cancellation/refund replay');
  const recovery=await place('16:00');assert.equal(recovery.status,201);state.recoveryId=recovery.body.order.id;
 }else if(phase==='outage'){
  const pending=await api(alice,`/api/bookings/${state.recoveryId}/cancel`,{});assert.equal(pending.status,202);assert.equal(pending.body.cancellation_status,'pending');pass('actual Payments container outage leaves cancellation pending');
 }else if(phase==='restart-pending'){
  assert.equal((await api(alice,'/api/me')).status,200);assert.notEqual((await api(alice,`/api/bookings/${state.recoveryId}`)).body.status,'cancelled');pass('restarted standalone Next preserves session and pending booking');
 }else if(phase==='recovered'){
  await until(async()=>((await api(alice,`/api/bookings/${state.recoveryId}`)).body.status==='cancelled'),'automatic cancellation recovery');
  assert.equal((await api(alice,`/api/bookings/${state.completedId}`)).body.status,'completed');
  pass('actual container recovery converges without another cancellation request');
 }else if(phase==='persisted'){
  assert.equal((await api(alice,'/api/me')).status,200);
  assert.equal((await api(alice,`/api/bookings/${state.completedId}`)).body.status,'completed');
  assert.equal((await api(alice,`/api/bookings/${state.refundId}`)).body.status,'cancelled');
  assert.equal((await api(alice,`/api/bookings/${state.recoveryId}`)).body.status,'cancelled');
  assert.equal((await api(alice,'/api/auth/logout',{}, {Origin:base})).status,200);assert.equal((await api(alice,'/api/me')).status,401);
  pass('persistent SQLite/sidecars/Keycloak/PG after full-stack restart + logout');
 }
 save();
}
