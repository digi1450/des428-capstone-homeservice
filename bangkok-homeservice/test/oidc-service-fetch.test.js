import test from "node:test";
import assert from "node:assert/strict";
import {fetchAsOidcUser} from "../lib/security/oidc-service-fetch.js";
import {seal,cookie} from "../lib/security/oidc-session.js";
const issuer="https://id.example.test/realms/homeservice",secret="0123456789abcdef0123456789abcdef";
const now=1800000000000;
const accessToken="eyJhbGciOiJSUzI1NiJ9."+Buffer.from(JSON.stringify({iss:issuer,sub:"subject-1",azp:"homeservice-web",aud:["notifications-service","payments-wallet-service"],exp:1800000100})).toString("base64url")+".signature";
const session=seal({issuer,sub:"subject-1",role:"customer",domainId:42,exp:1800000100,accessToken},secret);
const request=new Request("https://app.example.test",{headers:{Cookie:cookie("homeservice_oidc_session",session)}});
test("service fetch forwards user bearer only to allowlisted API origin",async()=>{
 const old=process.env.NOTIFICATIONS_SERVICE_URL;
 process.env.NOTIFICATIONS_SERVICE_URL="https://notifications.example.test";
 try{
  let captured;
  await fetchAsOidcUser(request,{service:"notifications",url:"/api/notifications",fetchImpl:async(url,options)=>{captured={url,options};return {ok:true};},sessionOptions:{secret,issuer,now:()=>now}});
  assert.equal(captured.url.origin,"https://notifications.example.test");
  assert.equal(captured.options.headers.Authorization,"Bearer "+accessToken);
  assert.equal(captured.options.redirect,"error");
  await assert.rejects(fetchAsOidcUser(request,{service:"notifications",url:"https://attacker.example.test/api/steal",sessionOptions:{secret,issuer,now:()=>now}}));
  await assert.rejects(fetchAsOidcUser(request,{service:"notifications",url:"/internal/commands",sessionOptions:{secret,issuer,now:()=>now}}));
 }finally{if(old===undefined)delete process.env.NOTIFICATIONS_SERVICE_URL;else process.env.NOTIFICATIONS_SERVICE_URL=old;}
});
