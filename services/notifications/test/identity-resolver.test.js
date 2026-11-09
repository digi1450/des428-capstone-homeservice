import test from "node:test";
import assert from "node:assert/strict";
import { createIdentityResolver } from "../src/security/identity-resolver.js";

const url="https://identity.example.test/internal/resolve";
const token="server-secret";
const query={issuer:"https://id.example.test/realms/homeservice",sub:"subject-1"};
test("identity resolver sends only verified issuer and subject with server credentials",async()=>{
 let sent;
 const resolve=createIdentityResolver({url,token,fetchImpl:async(_url,options)=>{sent=options;return {ok:true,json:async()=>({role:"provider",domainId:17})};}});
 assert.deepEqual(await resolve(query),{role:"provider",domainId:17});
 assert.deepEqual(JSON.parse(sent.body),query);
 assert.equal(sent.headers.Authorization,"Bearer server-secret");
 assert.equal(sent.redirect,"error");
});
test("missing and conflicting bindings deny identity",async()=>{
 for(const status of [404,409]){
  const resolve=createIdentityResolver({url,token,fetchImpl:async()=>({ok:false,status})});
  assert.equal(await resolve(query),null);
 }
});
test("resolver outage and invalid responses fail closed",async()=>{
 const outage=createIdentityResolver({url,token,fetchImpl:async()=>({ok:false,status:503})});
 await assert.rejects(outage(query));
 const poisoned=createIdentityResolver({url,token,fetchImpl:async()=>({ok:true,json:async()=>({role:"admin",domainId:1,debug:true})})});
 await assert.rejects(poisoned(query));
});
test("rejects non-TLS identity endpoints",()=>{
 assert.throws(()=>createIdentityResolver({url:"http://identity.example.test/resolve",token}));
});
