import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createGatewayWebhookVerifier } from "../src/security/booking-verifier.js";

const issuer="https://id.example.test/realms/homeservice", audience="payments-wallet-service";
const {privateKey,publicKey}=generateKeyPairSync("rsa",{modulusLength:2048});
const jwk={...publicKey.export({format:"jwk"}),kid:"gateway-key",alg:"RS256",use:"sig"};
const now=1800000000000;
function jwt({azp="mock-gateway-service",roles=["mock-gateway:settle_webhook"],sub="gateway-account"}={}) {
 const header=Buffer.from(JSON.stringify({alg:"RS256",kid:"gateway-key"})).toString("base64url");
 const payload=Buffer.from(JSON.stringify({iss:issuer,aud:audience,azp,sub,exp:1800000300,resource_access:{[audience]:{roles}}})).toString("base64url");
 return header+"."+payload+"."+sign("RSA-SHA256",Buffer.from(header+"."+payload),privateKey).toString("base64url");
}
const req=token=>({get:()=> "Bearer "+token});
const authenticate=createGatewayWebhookVerifier({issuer,now:()=>now,fetchImpl:async()=>({ok:true,json:async()=>({keys:[jwk]})})});
test("mock gateway may settle with signed client and explicit permission",async()=>{
 assert.deepEqual(await authenticate(req(jwt()),{operation:"settle_webhook"}),{service:"mock-gateway",callerId:issuer+"|gateway-account"});
});
test("Booking token and user token cannot call webhook even with valid audience",async()=>{
 for(const azp of ["booking-service","homeservice-web"])
  await assert.rejects(authenticate(req(jwt({azp})),{operation:"settle_webhook"}),e=>e.statusCode===401);
});
test("missing gateway role and unrelated operations are forbidden",async()=>{
 await assert.rejects(authenticate(req(jwt({roles:["booking:create"]})),{operation:"settle_webhook"}),e=>e.statusCode===403);
 await assert.rejects(authenticate(req(jwt()),{operation:"create"}),e=>e.statusCode===403);
});
