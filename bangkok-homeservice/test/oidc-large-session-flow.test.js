// Actual OIDC handlers + SQLite mapping/session store; signed JWT fixtures, not live Keycloak.
import {freshBoot,getDb} from '../test-helpers/boot.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,randomUUID} from 'node:crypto';
import {GET as start} from '../app/api/auth/keycloak/start/route.js';
import {GET as callback} from '../app/api/auth/keycloak/callback/route.js';
import {POST as refresh} from '../app/api/auth/keycloak/refresh/route.js';
import {POST as logout} from '../app/api/auth/keycloak/logout/route.js';
import {createIdentityMappingStore} from '../lib/security/identity-mapping.js';
import {createOidcSessionStore} from '../lib/security/oidc-session-store.js';
import {getServerOidcSession} from '../lib/security/oidc-server-session.js';
import {fetchAsOidcUser} from '../lib/security/oidc-service-fetch.js';
import {unseal,seal} from '../lib/security/oidc-session.js';
import {oidcSessionFixture} from '../test-helpers/oidc-sessions.js';

test('large signed tokens login, forward, refresh and logout with a fixed-size opaque cookie',async t=>{
 freshBoot();
 const issuer='https://id.example.test/realms/homeservice',origin='https://app.example.test',secret='s'.repeat(32),sub=randomUUID();
 const fixture=oidcSessionFixture(t,{secret}),oldEnv={};
 const env={OIDC_LOGIN_ENABLED:'true',KEYCLOAK_ISSUER:issuer,OIDC_REDIRECT_URI:origin+'/api/auth/keycloak/callback',OIDC_SESSION_SECRET:secret,IDENTITY_MAPPING_DB_PATH:fixture.path,OIDC_SESSION_DB_PATH:fixture.path,NOTIFICATIONS_SERVICE_URL:'https://notifications.example.test'};
 for(const [key,value]of Object.entries(env)){oldEnv[key]=process.env[key];process.env[key]=value;}
 const oldFetch=globalThis.fetch;
 t.after(()=>{globalThis.fetch=oldFetch;for(const [key,value]of Object.entries(oldEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
 const customer=getDb().prepare('SELECT id FROM customers LIMIT 1').get().id;
 const mapping=createIdentityMappingStore({path:fixture.path});mapping.provision({issuer,sub,role:'customer',domainId:customer});mapping.close();
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048}),kid=randomUUID();
 const jwk={...publicKey.export({format:'jwk'}),alg:'RS256',kid,use:'sig'};
 const jwt=claims=>{const h=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT',kid})).toString('base64url'),p=Buffer.from(JSON.stringify(claims)).toString('base64url');return h+'.'+p+'.'+sign('RSA-SHA256',Buffer.from(h+'.'+p),privateKey).toString('base64url');};
 const begin=await start(new Request(origin+'/api/auth/keycloak/start'));assert.equal(begin.status,302);
 const pendingCookie=begin.headers.get('set-cookie').split(';')[0],pending=unseal(pendingCookie.split('=')[1],secret),now=Math.floor(Date.now()/1000);
 const access=jwt({exp:now+300,iat:now,jti:randomUUID(),iss:issuer,aud:['account','notifications-service','payments-wallet-service'],sub,typ:'Bearer',azp:'homeservice-web',sid:randomUUID(),resource_access:{'notifications-service':{roles:['user:read']},'payments-wallet-service':{roles:['user:read']}},scope:'openid profile email',email_verified:true,name:'สมชาย ทดสอบระบบบริการภายในกรุงเทพมหานคร',profile_description:'ข้อมูลทดสอบ'.repeat(65)});
 const refreshToken=jwt({exp:now+1800,iat:now,iss:issuer,sub,typ:'Refresh',azp:'homeservice-web',sid:randomUUID(),nonce:pending.nonce});
 const id=jwt({iss:issuer,aud:'homeservice-web',sub,iat:now,exp:now+300,nonce:pending.nonce});
 const expected={issuer,sub,role:'customer',domainId:customer,exp:now+300,accessToken:access,nonce:pending.nonce,refreshToken};
 assert.ok(Buffer.byteLength(JSON.stringify(expected))>2800,'reproduce old cookie capacity failure');
 assert.throws(()=>seal(expected,secret),/too large/,'transaction cookie limit stays small');
 let tokenCalls=0;
 globalThis.fetch=async(url,options)=>{
  if(String(url).endsWith('/certs'))return {ok:true,json:async()=>({keys:[jwk]})};
  assert.equal(String(url),issuer+'/protocol/openid-connect/token');assert.equal(options.redirect,'error');tokenCalls++;
  if(tokenCalls>1)assert.equal(new URLSearchParams(options.body).get('refresh_token'),refreshToken);
  return {ok:true,json:async()=>({access_token:access,id_token:id,refresh_token:tokenCalls===1?refreshToken:refreshToken+'-rotated',token_type:'Bearer'})};
 };
 const result=await callback(new Request(origin+'/api/auth/keycloak/callback?state='+pending.state+'&code=fixture',{headers:{Cookie:pendingCookie}}));
 assert.equal(result.status,303);
 const cookie=result.headers.getSetCookie().find(x=>x.startsWith('homeservice_oidc_session='));
 assert.ok(cookie.length<200);assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);
 const sessionId=cookie.split(';')[0].split('=')[1];assert.equal(sessionId.length,43);
 const req=new Request(origin,{headers:{Cookie:'homeservice_oidc_session='+sessionId}});
 assert.deepEqual(getServerOidcSession(req),expected);
 await fetchAsOidcUser(req,{service:'notifications',url:'/api/notifications',fetchImpl:async(_url,options)=>{assert.equal(options.headers.Authorization,'Bearer '+access);return {ok:true};}});
 const refreshRequest=()=>new Request(origin+'/api/auth/keycloak/refresh',{method:'POST',headers:{Origin:origin,Cookie:'homeservice_oidc_session='+sessionId}});
 const renewed=await refresh(refreshRequest());assert.equal(renewed.status,200);assert.deepEqual(await renewed.json(),{ok:true});
 const next=renewed.headers.get('set-cookie').split(';')[0].split('=')[1];assert.equal(next.length,43);assert.notEqual(next,sessionId);
 const store=createOidcSessionStore();
 try{assert.equal(store.get(sessionId),null);assert.equal(store.get(next).refreshToken,refreshToken+'-rotated');}finally{store.close();}
 assert.equal((await refresh(refreshRequest())).status,401);assert.equal(tokenCalls,2,'consumed ID does not request another refresh');
 const ended=await logout(new Request(origin+'/api/auth/keycloak/logout',{method:'POST',headers:{Origin:origin,Cookie:'homeservice_oidc_session='+next}}));
 assert.equal(ended.status,200);
 assert.equal(getServerOidcSession(new Request(origin,{headers:{Cookie:'homeservice_oidc_session='+next}})),null,'logout revokes server session, including copied cookie');
});
