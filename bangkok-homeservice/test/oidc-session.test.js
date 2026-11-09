import test from "node:test";
import assert from "node:assert/strict";
import {generateKeyPairSync,sign} from "node:crypto";
import {verifyOidcIdToken} from "../lib/security/oidc-id-token.js";
import {seal,unseal,cookie,readCookie} from "../lib/security/oidc-session.js";
import {getServerOidcSession} from "../lib/security/oidc-server-session.js";
const issuer="https://id.example.test/realms/homeservice",secret="0123456789abcdef0123456789abcdef";
const {privateKey,publicKey}=generateKeyPairSync("rsa",{modulusLength:2048});
const jwk=publicKey.export({format:"jwk"});jwk.kid="test-key";jwk.alg="RS256";jwk.use="sig";
const now=1800000000000;
const token=claims=>{
 const header=Buffer.from(JSON.stringify({alg:"RS256",kid:"test-key"})).toString("base64url");
 const payload=Buffer.from(JSON.stringify(claims)).toString("base64url");
 return header+"."+payload+"."+sign("RSA-SHA256",Buffer.from(header+"."+payload),privateKey).toString("base64url");
};
const claims={iss:issuer,aud:"homeservice-web",nonce:"nonce-123",sub:"subject-1",iat:1799999900,exp:1800000100};
const fetchImpl=async()=>({ok:true,json:async()=>({keys:[jwk]})});
test("valid signed ID token verifies issuer, audience and nonce",async()=>{
 assert.deepEqual(await verifyOidcIdToken({token:token(claims),issuer,nonce:"nonce-123",fetchImpl,now:()=>now}),{issuer,sub:"subject-1",exp:1800000100});
});
test("ID token rejects nonce mismatch, wrong audience, expiry and tampering",async()=>{
 for(const override of [{nonce:"wrong"},{aud:"other"},{exp:1799999900},{iss:"https://other.test/realms/homeservice"}])
  await assert.rejects(verifyOidcIdToken({token:token({...claims,...override}),issuer,nonce:"nonce-123",fetchImpl,now:()=>now}));
 const raw=token(claims);await assert.rejects(verifyOidcIdToken({token:raw.slice(0,-2)+"xx",issuer,nonce:"nonce-123",fetchImpl,now:()=>now}));
});
test("encrypted browser session rejects modifications and expiry",()=>{
 const session={issuer,sub:"subject-1",role:"customer",domainId:42,exp:1800000100,accessToken:token({iss:issuer,sub:"subject-1",azp:"homeservice-web",exp:1800000100})};
 const sealed=seal(session,secret);
 assert.deepEqual(unseal(sealed,secret),session);
 assert.throws(()=>unseal(sealed.slice(0,-2)+"xx",secret));
 const request=new Request("https://app.example.test",{headers:{Cookie:cookie("homeservice_oidc_session",sealed)}});
 assert.equal(getServerOidcSession(request,{secret,issuer,now:()=>now}).domainId,42);
 assert.equal(getServerOidcSession(request,{secret,issuer,now:()=>1800000200000}),null);
 assert.equal(readCookie(request,"homeservice_oidc_session"),sealed);
});
