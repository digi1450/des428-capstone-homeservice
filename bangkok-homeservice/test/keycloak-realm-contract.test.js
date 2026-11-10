import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const realm=JSON.parse(readFileSync(new URL("../../infra/keycloak/homeservice-realm.json",import.meta.url),"utf8"));
const clients=Object.fromEntries(realm.clients.map(c=>[c.clientId,c]));
const scopes=Object.fromEntries(realm.clientScopes.map(s=>[s.name,s]));
test("realm has isolated human, Booking and gateway clients",()=>{
 assert.equal(realm.realm,"homeservice");
 assert.equal(clients["homeservice-web"].publicClient,true);
 assert.equal(clients["homeservice-web"].standardFlowEnabled,true);
 assert.deepEqual(clients["homeservice-web"].redirectUris,["http://localhost:3000/api/auth/keycloak/callback"]);
 assert.equal(clients["homeservice-web"].directAccessGrantsEnabled,false);
 assert.equal(clients["homeservice-web"].implicitFlowEnabled,false);
 assert.equal(clients["homeservice-web"].attributes["pkce.code.challenge.method"],"S256");
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
test('fresh realm explicitly defines every referenced scope and emits client roles',()=>{
 for(const c of realm.clients)for(const name of c.defaultClientScopes||[])assert.ok(scopes[name],`${c.clientId}: missing ${name}`);
 const mapper=scopes.roles.protocolMappers.find(m=>m.protocolMapper==='oidc-usermodel-client-role-mapper');
 assert.equal(mapper.config['claim.name'],'resource_access.${client_id}.roles');assert.equal(mapper.config['access.token.claim'],'true');
});
test('fresh Keycloak26 access tokens receive stable subject for all interactive/service clients',()=>{
 const mapper=scopes.basic.protocolMappers.find(m=>m.protocolMapper==='oidc-sub-mapper');assert.equal(mapper.config['access.token.claim'],'true');
 for(const name of ['homeservice-web','booking-service','mock-gateway-service'])assert.ok(clients[name].defaultClientScopes.includes('basic'));
});
test('self-registration grants browser read scope only, never Booking/Gateway/admin permissions',()=>{
 assert.equal(realm.registrationAllowed,true);
 const roles=clients['homeservice-web'].protocolMappers.filter(m=>m.protocolMapper==='oidc-hardcoded-role-mapper').map(m=>m.config.role);
 assert.deepEqual(new Set(roles),new Set(['notifications-service.user:read','payments-wallet-service.user:read']));
 for(const id of ['booking-service','mock-gateway-service'])assert.ok(!(clients[id].protocolMappers||[]).some(m=>m.protocolMapper==='oidc-hardcoded-role-mapper'));
});
