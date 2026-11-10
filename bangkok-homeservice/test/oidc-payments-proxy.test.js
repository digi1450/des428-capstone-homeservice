import test from "node:test";
import assert from "node:assert/strict";
import {GET as wallet} from "../app/api/provider/wallet/route.js";
import {GET as transactions} from "../app/api/customer/transactions/route.js";
import {cookie} from "../lib/security/oidc-session.js";
import {oidcSessionFixture} from "../test-helpers/oidc-sessions.js";
const issuer="https://id.example.test/realms/homeservice",secret="0123456789abcdef0123456789abcdef";
const now=Math.floor(Date.now()/1000);
const access="eyJhbGciOiJSUzI1NiJ9."+Buffer.from(JSON.stringify({iss:issuer,sub:"sub",azp:"homeservice-web",aud:["notifications-service","payments-wallet-service"],exp:now+300})).toString("base64url")+".signature";
const request=(role,sessions)=>new Request("https://app.example.test",{headers:{Cookie:cookie("homeservice_oidc_session",sessions.issue({issuer,sub:"sub",role,domainId:42,exp:now+300,accessToken:access}))}});
test("opt-in Payments proxy requires OIDC user session and correct role",async t=>{
 const sessions=oidcSessionFixture(t,{secret});
 const oldPath=process.env.OIDC_SESSION_DB_PATH;process.env.OIDC_SESSION_DB_PATH=sessions.path;
 t.after(()=>{if(oldPath===undefined)delete process.env.OIDC_SESSION_DB_PATH;else process.env.OIDC_SESSION_DB_PATH=oldPath;});
 const old={flag:process.env.AREA_B_PAYMENTS_PROXY,secret:process.env.OIDC_SESSION_SECRET,issuer:process.env.KEYCLOAK_ISSUER};
 process.env.AREA_B_PAYMENTS_PROXY="true";process.env.OIDC_SESSION_SECRET=secret;process.env.KEYCLOAK_ISSUER=issuer;
 try{
  assert.equal((await wallet(new Request("https://app.example.test"))).status,401);
  assert.equal((await transactions(new Request("https://app.example.test"))).status,401);
  assert.equal((await wallet(request("customer",sessions))).status,403);
  assert.equal((await transactions(request("provider",sessions))).status,403);
 }finally{for(const [key,value]of Object.entries(old)){const name=key==="flag"?"AREA_B_PAYMENTS_PROXY":key==="secret"?"OIDC_SESSION_SECRET":"KEYCLOAK_ISSUER";if(value===undefined)delete process.env[name];else process.env[name]=value;}}
});
