import test from "node:test";
import assert from "node:assert/strict";
import {POST as refresh} from "../app/api/auth/keycloak/refresh/route.js";
import {POST as logout} from "../app/api/auth/keycloak/logout/route.js";
test("refresh endpoint disabled without explicit configuration",async()=>{
 const original=process.env.OIDC_LOGIN_ENABLED;
 process.env.OIDC_LOGIN_ENABLED="false";
 try{
  const response=await refresh(new Request("https://app.example.test/api/auth/keycloak/refresh",{method:"POST",headers:{Origin:"https://app.example.test"}}));
  assert.equal(response.status,503);
 }finally{if(original===undefined)delete process.env.OIDC_LOGIN_ENABLED;else process.env.OIDC_LOGIN_ENABLED=original;}
});
test("logout refuses cross-origin POST and clears both cookies for same-origin",async()=>{
 const url="https://app.example.test/api/auth/keycloak/logout";
 const denied=await logout(new Request(url,{method:"POST",headers:{Origin:"https://evil.example.test"}}));
 assert.equal(denied.status,403);
 const ok=await logout(new Request(url,{method:"POST",headers:{Origin:"https://app.example.test"}}));
 assert.equal(ok.status,200);
 const cookies=ok.headers.getSetCookie();
 assert.equal(cookies.length,2);
 assert.ok(cookies.every(c=>c.includes("HttpOnly")&&c.includes("Secure")&&c.includes("Max-Age=0")));
});

test("refresh rejects cross-origin POST before accessing session",async()=>{
 const env={OIDC_LOGIN_ENABLED:process.env.OIDC_LOGIN_ENABLED,KEYCLOAK_ISSUER:process.env.KEYCLOAK_ISSUER,OIDC_SESSION_SECRET:process.env.OIDC_SESSION_SECRET,IDENTITY_MAPPING_DB_PATH:process.env.IDENTITY_MAPPING_DB_PATH};
 Object.assign(process.env,{OIDC_LOGIN_ENABLED:"true",KEYCLOAK_ISSUER:"https://id.example.test/realms/homeservice",OIDC_SESSION_SECRET:"0123456789abcdef0123456789abcdef",IDENTITY_MAPPING_DB_PATH:"/nonexistent/identity.db"});
 try{
  const url="https://app.example.test/api/auth/keycloak/refresh";
  const denied=await refresh(new Request(url,{method:"POST",headers:{Origin:"https://attacker.example.test"}}));
  assert.equal(denied.status,403);
  const missing=await refresh(new Request(url,{method:"POST",headers:{Origin:"https://app.example.test"}}));
  assert.equal(missing.status,401);
  const tampered=await refresh(new Request(url,{method:"POST",headers:{Origin:"https://app.example.test",Cookie:"homeservice_oidc_session=forged"}}));
  assert.equal(tampered.status,401);
 }finally{for(const [k,v] of Object.entries(env)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});
