import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const realm=JSON.parse(readFileSync(new URL("../infra/keycloak/homeservice-realm.json",import.meta.url),"utf8"));
const clients=Object.fromEntries(realm.clients.map(c=>[c.clientId,c]));
const scopes=Object.fromEntries(realm.clientScopes.map(s=>[s.name,s]));
test("realm has isolated human, Booking and gateway clients",()=>{
 assert.equal(realm.realm,"homeservice");
 assert.equal(clients["homeservice-web"].publicClient,true);
 assert.equal(clients["homeservice-web"].standardFlowEnabled,true);
 for(const id of ["booking-service","mock-gateway-service"]){
  assert.equal(clients[id].serviceAccountsEnabled,true);
  assert.equal(clients[id].standardFlowEnabled,false);
  assert.ok(clients[id].defaultClientScopes.includes("payments-audience"));
 }
 assert.equal(clients["payments-wallet-service"].bearerOnly,true);
 assert.equal(clients["notifications-service"].bearerOnly,true);
});
test("browser audience scope and client roles match verifier expectations",()=>{
 assert.ok(clients["homeservice-web"].defaultClientScopes.includes("homeservice-api-audiences"));
 const audiences=scopes["homeservice-api-audiences"].protocolMappers.map(m=>m.config["included.client.audience"]);
 assert.deepEqual(new Set(audiences),new Set(["notifications-service","payments-wallet-service"]));
 assert.ok(realm.roles.client["notifications-service"].some(r=>r.name==="user:read"));
 const payments=new Set(realm.roles.client["payments-wallet-service"].map(r=>r.name));
 for(const role of ["user:read","booking:create","booking:query","booking:cancel","booking:activate","booking:complete_financial","booking:cancel_financial","booking:query_financial","mock-gateway:settle_webhook"])assert.ok(payments.has(role),role);
});
