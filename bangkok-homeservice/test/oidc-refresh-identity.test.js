import test from "node:test";
import assert from "node:assert/strict";
import {generateKeyPairSync,sign} from "node:crypto";
import {POST as refresh} from "../app/api/auth/keycloak/refresh/route.js";
import {oidcSessionFixture} from "../test-helpers/oidc-sessions.js";

const issuer="https://id.example.test/realms/homeservice";
const secret="0123456789abcdef0123456789abcdef";
const origin="https://app.example.test";
const {privateKey,publicKey}=generateKeyPairSync("rsa",{modulusLength:2048});
const jwk={...publicKey.export({format:"jwk"}),kid:"refresh-fixture",alg:"RS256",use:"sig"};
function signed(claims){
 const header=Buffer.from(JSON.stringify({alg:"RS256",kid:"refresh-fixture"})).toString("base64url");
 const payload=Buffer.from(JSON.stringify(claims)).toString("base64url");
 return header+"."+payload+"."+sign("RSA-SHA256",Buffer.from(header+"."+payload),privateKey).toString("base64url");
}
test("refresh rejects a signed ID token whose subject differs from the original session",async t=>{
 const sessions=oidcSessionFixture(t,{secret});
 const original={};
 for(const key of ["OIDC_LOGIN_ENABLED","KEYCLOAK_ISSUER","OIDC_SESSION_SECRET","IDENTITY_MAPPING_DB_PATH","OIDC_SESSION_DB_PATH"])original[key]=process.env[key];
 const originalFetch=globalThis.fetch;
 Object.assign(process.env,{OIDC_LOGIN_ENABLED:"true",KEYCLOAK_ISSUER:issuer,OIDC_SESSION_SECRET:secret,IDENTITY_MAPPING_DB_PATH:"/nonexistent/identity.db",OIDC_SESSION_DB_PATH:sessions.path});
 const now=Math.floor(Date.now()/1000);
 const idToken=signed({iss:issuer,aud:"homeservice-web",sub:"attacker-subject",nonce:"original-nonce",iat:now-5,exp:now+300});
 const session=sessions.issue({issuer,sub:"victim-subject",nonce:"original-nonce",refreshToken:"fixture-refresh-token",exp:now+300});
 let calls=0;
 globalThis.fetch=async url=>{
  calls++;
  if(String(url).endsWith("/token"))return {ok:true,json:async()=>({id_token:idToken,access_token:"fixture.access.token",refresh_token:"new-refresh-token",token_type:"Bearer"})};
  if(String(url).endsWith("/certs"))return {ok:true,json:async()=>({keys:[jwk]})};
  throw Error("unexpected URL");
 };
 try{
  const response=await refresh(new Request(origin+"/api/auth/keycloak/refresh",{method:"POST",headers:{Origin:origin,Cookie:"homeservice_oidc_session="+session}}));
  assert.equal(response.status,401);
  assert.equal((await response.json()).error,"refresh failed");
  assert.match(response.headers.get("set-cookie"),/Max-Age=0/);
  assert.equal(calls,2);
 }finally{
  globalThis.fetch=originalFetch;
  for(const [key,value] of Object.entries(original)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 }
});
