// Run inside the monolith directory AFTER next build, with Linux locked dependencies.
// HTTPS service and OIDC session are fixtures. This proves real Next bundle/request wiring,
// not Keycloak issuance, receiving-service JWT verification or AMQP business delivery.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import https from 'node:https';
import {createRequire} from 'node:module';
const require=createRequire(join(process.cwd(),'package.json'));
const jwt=require('jsonwebtoken');
const directory=mkdtempSync(join(tmpdir(),'next-auth-startup-'));
const secret='fixture-session-secret-'.repeat(3),issuer='https://id.example.test/realms/homeservice';
process.env.DB_PATH=join(directory,'booking.sqlite');
process.env.NODE_ENV='production';
const {bootstrapDb}=await import('../bangkok-homeservice/lib/db/bootstrap.js');
const {closeDb}=await import('../bangkok-homeservice/lib/db/index.js');
const db=bootstrapDb(),provider=db.prepare('SELECT id FROM providers LIMIT 1').get().id;
const {createIdentityMappingStore}=await import('../bangkok-homeservice/lib/security/identity-mapping.js');
const {createOidcSessionStore}=await import('../bangkok-homeservice/lib/security/oidc-session-store.js');
const bindingsPath=join(directory,'bindings.sqlite'),sessionPath=join(directory,'sessions.sqlite');
const binding=createIdentityMappingStore({path:bindingsPath});binding.provision({issuer,sub:'fixture-provider',role:'provider',domainId:provider});binding.close();
const exp=Math.floor(Date.now()/1000)+600;
const accessToken='eyJhbGciOiJSUzI1NiJ9.'+Buffer.from(JSON.stringify({iss:issuer,sub:'fixture-provider',azp:'homeservice-web',exp,aud:['payments-wallet-service','notifications-service']})).toString('base64url')+'.fixture';
const store=createOidcSessionStore({path:sessionPath,secret});
const sid=store.create({issuer,sub:'fixture-provider',role:'provider',domainId:provider,exp,accessToken});store.close();closeDb();
let hits=0,unavailable=false;
const tls=https.createServer({key:readFileSync(process.argv[2]),cert:readFileSync(process.argv[3])},(req,res)=>{
 assert.equal(req.url,'/api/provider/wallet');assert.equal(req.headers.authorization,'Bearer '+accessToken);hits++;
 if(unavailable){res.writeHead(503,{'content-type':'application/json'});res.end('{}');return;}
 res.writeHead(200,{'content-type':'application/json'});
 res.end(JSON.stringify({provider_id:provider,balance_cents:null,commission_owed_cents:null,transactions:[],wallet_setup:'pending'}));
});
await new Promise(resolve=>tls.listen(0,'127.0.0.1',resolve));
const serviceUrl='https://127.0.0.1:'+tls.address().port;
const env={...process.env,NEXT_RUNTIME:'nodejs',JWT_SECRET:'fixture-legacy-secret',AUTHENTICATED_SERVICES_ENABLED:'true',AUTHENTICATED_CUTOVER_APPROVED:'true',OIDC_LOGIN_ENABLED:'true',AREA_B_NOTIFICATIONS_PROXY:'false',AREA_B_PAYMENTS_PROXY:'false',KEYCLOAK_ISSUER:issuer,PAYMENTS_WALLET_SERVICE_URL:serviceUrl,NOTIFICATIONS_SERVICE_URL:serviceUrl,BOOKING_SERVICE_CLIENT_SECRET:'fixture-booking-secret',OIDC_SESSION_SECRET:secret,IDENTITY_MAPPING_DB_PATH:bindingsPath,OIDC_SESSION_DB_PATH:sessionPath,OIDC_REDIRECT_URI:'https://app.example.test/api/auth/keycloak/callback',AMQP_URL:'amqp://fixture:fixture@127.0.0.1:1',NODE_EXTRA_CA_CERTS:process.argv[3]};
let child,logs='';
const launch=(port,overrides={})=>{
 const c=spawn(process.execPath,[require.resolve('next/dist/bin/next'),'start','-H','127.0.0.1','-p',String(port)],{env:{...env,...overrides},stdio:['ignore','pipe','pipe']});
 c.stdout.on('data',data=>{logs+=data;});c.stderr.on('data',data=>{logs+=data;});return c;
};
try{
 child=launch(3199);
 const base='http://127.0.0.1:3199';
 let ready=false;
 for(let i=0;i<150;i++){
  if(child.exitCode!==null)throw Error('Next terminated during boot');
  try{ready=(await fetch(base+'/api/health')).ok;if(ready)break;}catch{}
  await new Promise(resolve=>setTimeout(resolve,200));
 }
 assert.ok(ready,'Next ready within deadline');
 const legacy=jwt.sign({sub:provider,role:'provider'},env.JWT_SECRET);
 const old=await fetch(base+'/api/provider/wallet',{headers:{Cookie:'edemand_token='+legacy}});assert.equal(old.status,401,'valid legacy cookie cannot bypass selected OIDC identity');
 const pageOld=await fetch(base+'/provider/wallet',{headers:{Cookie:'edemand_token='+legacy},redirect:'manual'});assert.equal(pageOld.status,307);assert.equal(new URL(pageOld.headers.get('location'),base).pathname,'/provider/login');
 const login=await fetch(base+'/provider/login',{redirect:'manual'});assert.equal(login.status,307);assert.equal(new URL(login.headers.get('location'),base).pathname,'/api/auth/keycloak/start');
 const headers={Cookie:'homeservice_oidc_session='+sid};
 const api=await fetch(base+'/api/provider/wallet',{headers});assert.equal(api.status,200);assert.equal((await api.json()).wallet_setup,'pending');
 const page=await fetch(base+'/provider/wallet',{headers,redirect:'manual'});assert.equal(page.status,200);assert.match(await page.text(),/Your wallet is being prepared/);assert.equal(hits,2,'API and actual RSC use remote client with current session');
 unavailable=true;assert.equal((await fetch(base+'/api/provider/wallet',{headers})).status,503,'remote failure retains typed status across bundles');
 const Database=require('better-sqlite3'),removed=new Database(bindingsPath);removed.exec('DELETE FROM keycloak_identity_bindings');removed.close();
 assert.equal((await fetch(base+'/api/provider/wallet',{headers})).status,401,'removed mapping fails closed with typed status across bundles');
 console.log('PASS compiled Next startup: legacy-cookie rejection, API identity, login redirect, RSC credentials and HTTPS remote wallet');
 child.kill('SIGTERM');await once(child,'exit');child=null;
 logs='';child=launch(3199,{AUTHENTICATED_CUTOVER_APPROVED:'false'});
 const failed=await Promise.race([once(child,'exit'),new Promise((_,reject)=>setTimeout(()=>reject(Error('Invalid startup did not exit')),10000).unref())]);
 assert.notEqual(failed[0],0);assert.match(logs,/Application startup failed; refusing to serve requests/);
 console.log('PASS compiled Next invalid configuration exits before serving');
}catch(error){console.error(logs.replaceAll('fixture-booking-secret','[fixture]'));throw error;}
finally{if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}await new Promise(resolve=>tls.close(resolve));rmSync(directory,{recursive:true,force:true});}
