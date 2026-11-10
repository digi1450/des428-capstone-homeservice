import test from "node:test";
import assert from "node:assert/strict";
import {generateKeyPairSync,sign} from "node:crypto";
import {createApp} from "../src/app.js";
import {createUserVerifier} from "../src/security/user-verifier.js";
const issuer="https://id.example.test/realms/homeservice",audience="payments-wallet-service",clock=1800000000000;
const {privateKey,publicKey}=generateKeyPairSync("rsa",{modulusLength:2048});
const jwk={...publicKey.export({format:"jwk"}),kid:"fixture",alg:"RS256",use:"sig"};
const claims={iss:issuer,aud:audience,azp:"homeservice-web",sub:"customer-owner",exp:1800000300,resource_access:{[audience]:{roles:["user:read"]}}};
function jwt(extra={}){const a=Buffer.from(JSON.stringify({alg:"RS256",kid:"fixture"})).toString("base64url"),b=Buffer.from(JSON.stringify({...claims,...extra})).toString("base64url");return a+"."+b+"."+sign("RSA-SHA256",Buffer.from(a+"."+b),privateKey).toString("base64url");}
test("HTTP Payments verifies JWT and blocks cross-account intent reads",async t=>{
 const intent={id:41,order_id:101,customer_id:7,provider_id:9,amount_cents:1000,gateway_ref:"private-ref",status:"requires_payment"};
 const database={query:async(sql,args)=>({rows:sql.includes("FROM payment_intents WHERE order_id")&&args[0]===101?[intent]:[]})};
 const authenticate=createUserVerifier({issuer,audience,now:()=>clock,resolveIdentity:async({sub})=>sub==="customer-owner"?{role:"customer",domainId:7}:sub==="provider-owner"?{role:"provider",domainId:9}:sub==="other"?{role:"customer",domainId:8}:{role:"admin",domainId:7},fetchImpl:async()=>({ok:true,json:async()=>({keys:[jwk]})})});
 const server=createApp({database,authenticate}).listen(0,"127.0.0.1");
 await new Promise(resolve=>server.once("listening",resolve));
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const origin="http://127.0.0.1:"+server.address().port;
 const call=token=>fetch(origin+"/api/booking-payment-intents/101?customer_id=7",{headers:token?{Authorization:"Bearer "+token}:{}});
 assert.equal((await call()).status,401);
 assert.equal((await call(jwt({exp:1}))).status,401);
 assert.equal((await call(jwt({aud:"notifications-service"}))).status,401);
 assert.equal((await call(jwt({sub:"other",role:"customer",domainId:7}))).status,403);
 assert.equal((await call(jwt({sub:"admin"}))).status,403);
 assert.equal((await call(jwt())).status,200);
 assert.equal((await call(jwt({sub:"provider-owner"}))).status,200);
});
