import test from "node:test";
import assert from "node:assert/strict";
import {generateKeyPairSync,sign} from "node:crypto";
import {createApp} from "../src/app.js";
import {createUserVerifier} from "../src/security/user-verifier.js";
const issuer="https://id.example.test/realms/homeservice",audience="notifications-service",clock=1800000000000;
const {privateKey,publicKey}=generateKeyPairSync("rsa",{modulusLength:2048});
const jwk={...publicKey.export({format:"jwk"}),kid:"fixture",alg:"RS256",use:"sig"};
const claims={iss:issuer,aud:audience,azp:"homeservice-web",sub:"owner",exp:1800000300,resource_access:{[audience]:{roles:["user:read"]}}};
function jwt(extra={}){const a=Buffer.from(JSON.stringify({alg:"RS256",kid:"fixture"})).toString("base64url"),b=Buffer.from(JSON.stringify({...claims,...extra})).toString("base64url");return a+"."+b+"."+sign("RSA-SHA256",Buffer.from(a+"."+b),privateKey).toString("base64url");}
test("HTTP Notifications enforces signed JWT, mapped ownership and BOLA protection",async t=>{
 const rows=[{id:11,recipient_role:"customer",recipient_id:7,type:"booking_status",title:"Owner",body:"private",order_id:5,read_at:null,created_at:"2026-11-09T00:00:00Z"},{id:12,recipient_role:"customer",recipient_id:8,type:"booking_status",title:"Other",body:"secret",order_id:6,read_at:null,created_at:"2026-11-09T00:00:00Z"}];
 const database={query:async(sql,args)=>({rows:sql.includes("UPDATE notifications")?[]:sql.includes("WHERE id = $1")?rows.filter(x=>x.id===args[0]):rows.filter(x=>x.recipient_role===args[0]&&x.recipient_id===args[1])})};
 const authenticate=createUserVerifier({issuer,audience,now:()=>clock,resolveIdentity:async({sub})=>({role:"customer",domainId:sub==="owner"?7:8}),fetchImpl:async()=>({ok:true,json:async()=>({keys:[jwk]})})});
 const server=createApp({database,authenticate}).listen(0,"127.0.0.1");
 await new Promise(resolve=>server.once("listening",resolve));
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const origin="http://127.0.0.1:"+server.address().port;
 const call=(path,token,method="GET")=>fetch(origin+path,{method,headers:token?{Authorization:"Bearer "+token}:{}});
 assert.equal((await call("/api/notifications")).status,401);
 assert.equal((await call("/api/notifications",jwt({exp:1}))).status,401);
 assert.equal((await call("/api/notifications",jwt({aud:"payments-wallet-service"}))).status,401);
 assert.equal((await call("/api/notifications",jwt({sub:"owner",domainId:8,role:"admin"}))).status,200);
 const inbox=await (await call("/api/notifications?recipient_id=8&role=admin",jwt())).json();
 assert.deepEqual(inbox.map(x=>x.id),[11]);
 assert.equal((await call("/api/notifications/12/read",jwt(),"POST")).status,403);
 assert.equal((await call("/api/notifications/11/read",jwt({sub:"other"}),"POST")).status,403);
});
