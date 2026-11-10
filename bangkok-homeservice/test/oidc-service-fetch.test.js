import test from "node:test";
import assert from "node:assert/strict";
import {fetchAsOidcUser} from "../lib/security/oidc-service-fetch.js";
import {cookie} from "../lib/security/oidc-session.js";
import {oidcSessionFixture} from "../test-helpers/oidc-sessions.js";
const issuer="https://id.example.test/realms/homeservice",secret="0123456789abcdef0123456789abcdef";
const now=1800000000000;
const accessToken="eyJhbGciOiJSUzI1NiJ9."+Buffer.from(JSON.stringify({iss:issuer,sub:"subject-1",azp:"homeservice-web",aud:["notifications-service","payments-wallet-service"],exp:1800000100})).toString("base64url")+".signature";
const session={issuer,sub:"subject-1",role:"customer",domainId:42,exp:1800000100,accessToken};
test("service fetch forwards user bearer only to allowlisted API origin",async t=>{
 const sessions=oidcSessionFixture(t,{secret,now:()=>now});
 const request=new Request("https://app.example.test",{headers:{Cookie:cookie("homeservice_oidc_session",sessions.issue(session))}});
 const old=process.env.NOTIFICATIONS_SERVICE_URL;
 process.env.NOTIFICATIONS_SERVICE_URL="https://notifications.example.test";
 try{
  let captured;
  await fetchAsOidcUser(request,{service:"notifications",url:"/api/notifications",fetchImpl:async(url,options)=>{captured={url,options};return {ok:true};},sessionOptions:{secret,issuer,path:sessions.path,now:()=>now}});
  assert.equal(captured.url.origin,"https://notifications.example.test");
  assert.equal(captured.options.headers.Authorization,"Bearer "+accessToken);
  assert.equal(captured.options.redirect,"error");
  const wrongAudienceToken="eyJhbGciOiJSUzI1NiJ9."+Buffer.from(JSON.stringify({iss:issuer,sub:"subject-1",azp:"homeservice-web",aud:"payments-wallet-service",exp:1800000100})).toString("base64url")+".signature";
  const wrongSession=sessions.issue({issuer,sub:"subject-1",role:"customer",domainId:42,exp:1800000100,accessToken:wrongAudienceToken});
  const wrongRequest=new Request("https://app.example.test",{headers:{Cookie:cookie("homeservice_oidc_session",wrongSession)}});
  await assert.rejects(fetchAsOidcUser(wrongRequest,{service:"notifications",url:"/api/notifications",fetchImpl:async()=>{throw Error("must not forward");},sessionOptions:{secret,issuer,path:sessions.path,now:()=>now}}));
  await assert.rejects(fetchAsOidcUser(request,{service:"notifications",url:"https://attacker.example.test/api/steal",sessionOptions:{secret,issuer,path:sessions.path,now:()=>now}}));
  await assert.rejects(fetchAsOidcUser(request,{service:"notifications",url:"/internal/commands",sessionOptions:{secret,issuer,path:sessions.path,now:()=>now}}));
  for(const attack of ["/api/../internal/commands","/api/%2e%2e/internal/commands","/api/%2f%2fattacker","/api/notifications?redirect=https://attacker.example.test","/api/notifications#fragment"])await assert.rejects(fetchAsOidcUser(request,{service:"notifications",url:attack,sessionOptions:{secret,issuer,path:sessions.path,now:()=>now}}));
 }finally{if(old===undefined)delete process.env.NOTIFICATIONS_SERVICE_URL;else process.env.NOTIFICATIONS_SERVICE_URL=old;}
});
