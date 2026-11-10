import {oidcRequestUrl} from "#lib/security/oidc-origin.js";
import {readCookie,cookie} from "#lib/security/oidc-session.js";
import {verifyOidcIdToken} from "#lib/security/oidc-id-token.js";
import {createIdentityMappingStore} from "#lib/security/identity-mapping.js";
import {createOidcSessionStore,isOidcSessionId} from "#lib/security/oidc-session-store.js";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request){
 let url;try{url=oidcRequestUrl(request);}catch{return Response.json({error:"origin mismatch"},{status:503});}
 const issuer=process.env.KEYCLOAK_ISSUER,secret=process.env.OIDC_SESSION_SECRET,path=process.env.IDENTITY_MAPPING_DB_PATH;
 if(process.env.OIDC_LOGIN_ENABLED!=="true"||!issuer||!secret||!path)return Response.json({error:"unavailable"},{status:503});
 if(request.headers.get("origin")!==url.origin)return Response.json({error:"origin required"},{status:403});
 const secure=url.protocol==="https:";
 const sessionId=readCookie(request,"homeservice_oidc_session");
 if(!isOidcSessionId(sessionId))return Response.json({error:"invalid session"},{status:401});
 let previous,sessionStore;
 try{sessionStore=createOidcSessionStore();previous=sessionStore.get(sessionId);}catch{return Response.json({error:"session unavailable"},{status:503});}finally{sessionStore?.close();}
 if(previous?.issuer!==issuer||typeof previous.sub!=="string"||!previous.sub||typeof previous.refreshToken!=="string"||!previous.refreshToken||
 typeof previous.nonce!=="string"||!previous.nonce)return Response.json({error:"refresh unavailable"},{status:401,headers:{"Cache-Control":"no-store"}});
 try{
  const endpoint=new URL(issuer);
  if(endpoint.protocol!=="https:"||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||!/^\/realms\/[^/]+$/.test(endpoint.pathname)||endpoint.href!==issuer)throw Error("issuer");
  const response=await fetch(issuer+"/protocol/openid-connect/token",{method:"POST",redirect:"error",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",client_id:"homeservice-web",refresh_token:previous.refreshToken}),signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw Error("refresh failed");
  const tokens=await response.json();
  if(typeof tokens.id_token!=="string"||typeof tokens.access_token!=="string"||typeof tokens.refresh_token!=="string"||tokens.token_type?.toLowerCase()!=="bearer")throw Error("invalid refresh");
  const verified=await verifyOidcIdToken({token:tokens.id_token,issuer,nonce:previous.nonce,refresh:true});
  if(verified.sub!==previous.sub)throw Error("subject changed");
  const parts=tokens.access_token.split(".");
  if(parts.length!==3)throw Error("invalid access token");
  const claims=JSON.parse(Buffer.from(parts[1],"base64url").toString("utf8"));
  const now=Math.floor(Date.now()/1000);
  if(claims.iss!==issuer||claims.sub!==verified.sub||claims.azp!=="homeservice-web"||!Number.isSafeInteger(claims.exp)||claims.exp<=now)throw Error("access claims");
  let store,identity;
  try{store=createIdentityMappingStore({path});identity=store.lookup({issuer,sub:verified.sub});}finally{store?.close();}
  if(!identity)throw Error("binding removed");
  const exp=Math.min(verified.exp,claims.exp,now+600);
  let updatedStore,value;
  try{updatedStore=createOidcSessionStore();value=updatedStore.rotate(sessionId,{issuer,sub:verified.sub,role:identity.role,domainId:identity.domainId,nonce:previous.nonce,exp,accessToken:tokens.access_token,refreshToken:tokens.refresh_token});}finally{updatedStore?.close();}
  if(!value)return Response.json({error:"session changed; refresh not applied"},{status:409});
  return Response.json({ok:true},{headers:{"Cache-Control":"no-store","Set-Cookie":cookie("homeservice_oidc_session",value,{maxAge:Math.max(1,exp-now),secure})}});
 }catch{
  // Invalidate only the original ID. Never clear the browser cookie here: this
  // response may arrive after another tab installed a newer session cookie.
  let store;
  try{store=createOidcSessionStore();store.remove(sessionId);}catch{return Response.json({error:"session unavailable"},{status:503,headers:{"Cache-Control":"no-store"}});}finally{store?.close();}
  return Response.json({error:"refresh failed"},{status:401,headers:{"Cache-Control":"no-store"}});
 }
}
