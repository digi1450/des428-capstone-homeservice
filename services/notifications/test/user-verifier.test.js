import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createUserVerifier } from "../src/security/user-verifier.js";

const issuer = "https://id.example.test/realms/homeservice";
const audience = "notifications-service";
const now = 1800000000000;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const key = { ...publicKey.export({format:"jwk"}), kid:"test", alg:"RS256", use:"sig" };
const claims = { iss:issuer, aud:audience, azp:"homeservice-web", sub:"uuid-user", exp:1800000300, resource_access:{[audience]:{roles:["user:read"]}} };
function token(extra={}) {
 const a=Buffer.from(JSON.stringify({alg:"RS256",kid:"test"})).toString("base64url");
 const b=Buffer.from(JSON.stringify({...claims,...extra})).toString("base64url");
 return a+"."+b+"."+sign("RSA-SHA256",Buffer.from(a+"."+b),privateKey).toString("base64url");
}
const request=t=>({get:()=> "Bearer "+t});
function create(resolveIdentity=async()=>({role:"customer",domainId:7})) {
 return createUserVerifier({issuer,audience,resolveIdentity,now:()=>now,fetchImpl:async()=>({ok:true,json:async()=>({keys:[key]})})});
}
test("maps verified subject to trusted legacy identity, never token ID or headers",async()=>{
 const seen=[];
 const authenticate=create(async input=>{seen.push(input);return {role:"customer",domainId:7};});
 assert.deepEqual(await authenticate(request(token({domainId:999,role:"admin"}))),{role:"customer",domainId:7});
 assert.deepEqual(seen,[{issuer,sub:"uuid-user"}]);
});
test("rejects invalid issuer, audience, client, expiry, and missing permission",async()=>{
 const authenticate=create();
 for(const bad of [
  token({iss:issuer+"-fake"}),token({aud:"payments-wallet-service"}),
  token({azp:"booking-service"}),token({exp:1}),
  token({resource_access:{}})
 ]) await assert.rejects(authenticate(request(bad)),e=>[401,403].includes(e.statusCode));
});
test("rejects absent and invalid mapping; resolver outage fails closed",async()=>{
 for(const identity of [null,{role:"admin",domainId:0},{role:"customer",domainId:"7"}]){
  await assert.rejects(create(async()=>identity)(request(token())),e=>e.statusCode===401);
 }
 await assert.rejects(create(async()=>{throw Error("database offline");})(request(token())),e=>e.statusCode===503);
});
