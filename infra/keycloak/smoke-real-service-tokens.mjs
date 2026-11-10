#!/usr/bin/env node
// Real Keycloak integration smoke test. Requires a running HTTPS realm and
// deployment-provided confidential client secrets. Does not print tokens/secrets.
import assert from "node:assert/strict";
import {createBookingServiceVerifier,createGatewayWebhookVerifier} from "../../services/payments-wallet/src/security/booking-verifier.js";
const issuer=process.env.KEYCLOAK_ISSUER;
const bookingSecret=process.env.KEYCLOAK_BOOKING_CLIENT_SECRET;
const gatewaySecret=process.env.KEYCLOAK_GATEWAY_CLIENT_SECRET;
if(!issuer?.startsWith("https://")||!bookingSecret||!gatewaySecret){
 console.error("Set KEYCLOAK_ISSUER (HTTPS), KEYCLOAK_BOOKING_CLIENT_SECRET and KEYCLOAK_GATEWAY_CLIENT_SECRET; no tokens were requested.");
 process.exit(2);
}
const tokenEndpoint=issuer+"/protocol/openid-connect/token";
async function obtain(clientId,secret){
 const response=await fetch(tokenEndpoint,{method:"POST",redirect:"error",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"client_credentials",client_id:clientId,client_secret:secret}),signal:AbortSignal.timeout(10000)});
 if(!response.ok) throw Error(clientId+" token endpoint returned HTTP "+response.status);
 const body=await response.json();
 assert.equal(typeof body.access_token,"string");
 return body.access_token;
}
const req=token=>({get:name=>name==="authorization"?"Bearer "+token:undefined});
async function expectStatus(promise,status,label){await assert.rejects(promise,error=>error.statusCode===status,label);}
try{
 const bookingToken=await obtain("booking-service",bookingSecret);
 const gatewayToken=await obtain("mock-gateway-service",gatewaySecret);
 const refreshedBookingToken=await obtain("booking-service",bookingSecret);
 const booking=createBookingServiceVerifier({issuer});
 const gateway=createGatewayWebhookVerifier({issuer});
 for(const operation of ["create","query","cancel","activate","complete_financial","cancel_financial","query_financial"]){
  const actor=await booking(req(bookingToken),{operation});
  assert.equal(actor.service,"booking");
  assert.ok(actor.callerId.startsWith(issuer+"|"));
 }
 const refreshedActor=await booking(req(refreshedBookingToken),{operation:"create"});
 assert.equal(refreshedActor.callerId,(await booking(req(bookingToken),{operation:"create"})).callerId,"Booking callerId must survive new token issuance");
 const gatewayActor=await gateway(req(gatewayToken),{operation:"settle_webhook"});
 assert.equal(gatewayActor.service,"mock-gateway");
 await expectStatus(booking(req(gatewayToken),{operation:"create"}),401,"Gateway token cannot impersonate Booking");
 await expectStatus(gateway(req(bookingToken),{operation:"settle_webhook"}),401,"Booking token cannot impersonate Gateway");
 await expectStatus(booking(req(bookingToken),{operation:"settle_webhook"}),403,"Booking cannot invoke gateway-only operation");
 await expectStatus(gateway(req(gatewayToken),{operation:"create"}),403,"Gateway cannot invoke Booking operation");
 const bookingParts=bookingToken.split(".");
 const payload=JSON.parse(Buffer.from(bookingParts[1],"base64url").toString("utf8"));
 const gatewayPayload=JSON.parse(Buffer.from(gatewayToken.split(".")[1],"base64url").toString("utf8"));
 const bookingRoles=payload.resource_access?.["payments-wallet-service"]?.roles??[];
 const gatewayRoles=gatewayPayload.resource_access?.["payments-wallet-service"]?.roles??[];
 assert.ok(!bookingRoles.includes("mock-gateway:settle_webhook"),"Booking service account must not have gateway role");
 assert.ok(!gatewayRoles.some(role=>role.startsWith("booking:")),"Gateway service account must not have Booking roles");
 assert.ok(!bookingRoles.includes("user:read")&&!gatewayRoles.includes("user:read"),"Service accounts must not have human API roles");
 assert.equal(payload.iss,issuer);
 assert.ok(payload.aud==="payments-wallet-service"||(Array.isArray(payload.aud)&&payload.aud.includes("payments-wallet-service")));
 await expectStatus(booking(req(bookingParts[0]+"."+Buffer.from(JSON.stringify({...payload,sub:"forged"})).toString("base64url")+"."+bookingParts[2]),{operation:"create"}),401,"Forged signature rejected");
 await expectStatus(booking(req(),{operation:"create"}),401,"Missing token rejected");
 console.log("PASS: real Keycloak Booking/Gateway issuance, role grants, audience, signature and client isolation");
}catch(error){
 console.error("FAIL: real Keycloak smoke test:",error.message);
 process.exitCode=1;
}
