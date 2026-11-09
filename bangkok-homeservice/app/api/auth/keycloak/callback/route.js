import {timingSafeEqual} from "node:crypto";
import {exchangeAuthorizationCode} from "#lib/security/oidc-pkce.js";
import {verifyOidcIdToken} from "#lib/security/oidc-id-token.js";
import {seal,unseal,cookie,readCookie} from "#lib/security/oidc-session.js";
import {createIdentityMappingStore} from "#lib/security/identity-mapping.js";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const equal=(a,b)=>typeof a==="string"&&typeof b==="string"&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export async function GET(request){
 const issuer=process.env.KEYCLOAK_ISSUER,redirectUri=process.env.OIDC_REDIRECT_URI,secret=process.env.OIDC_SESSION_SECRET,path=process.env.IDENTITY_MAPPING_DB_PATH;
 if(process.env.OIDC_LOGIN_ENABLED!=="true"||!issuer||!redirectUri||!secret||!path)return Response.json({error:"unavailable"},{status:503});
 const origin=new URL(request.url);
 if(new URL(redirectUri).origin!==origin.origin)return Response.json({error:"origin mismatch"},{status:503});
 const secure=origin.protocol==="https:";
 const clear=cookie("homeservice_oidc_pending","",{maxAge:0,secure});
 const params=origin.searchParams;
 let pending;
 try{pending=unseal(readCookie(request,"homeservice_oidc_pending"),secret);}catch{return Response.json({error:"invalid login state"},{status:401,headers:{"Set-Cookie":clear}});}
 if(!equal(params.get("state"),pending.state)||!Number.isFinite(pending.created)||Date.now()-pending.created>300000||pending.created>Date.now()||!params.get("code"))
   return Response.json({error:"invalid login state"},{status:401,headers:{"Set-Cookie":clear}});
 try{
  const tokens=await exchangeAuthorizationCode({issuer,redirectUri,code:params.get("code"),verifier:pending.verifier});
  const verified=await verifyOidcIdToken({token:tokens.id_token,issuer,nonce:pending.nonce});
  let store;
  let identity;
  try{store=createIdentityMappingStore({path});identity=store.lookup({issuer,sub:verified.sub});}finally{store?.close();}
  if(!identity)return Response.json({error:"account not provisioned"},{status:403,headers:{"Set-Cookie":clear}});
  // Decode the access-token expiry only as a session lifetime bound.
  // The downstream service performs the authoritative JWT verification.
  const accessParts=tokens.access_token.split(".");
  if(accessParts.length!==3)throw Error("invalid access token");
  const accessClaims=JSON.parse(Buffer.from(accessParts[1],"base64url").toString("utf8"));
  if(accessClaims.iss!==issuer||accessClaims.sub!==verified.sub||accessClaims.azp!=="homeservice-web"||
     !Number.isSafeInteger(accessClaims.exp)||accessClaims.exp<=Math.floor(Date.now()/1000))throw Error("invalid access token claims");
  const expiry=Math.min(verified.exp,accessClaims.exp,Math.floor(Date.now()/1000)+600);
  const session=seal({issuer,sub:verified.sub,role:identity.role,domainId:identity.domainId,exp:expiry,accessToken:tokens.access_token,refreshToken:typeof tokens.refresh_token==="string"?tokens.refresh_token:null},secret);
  const headers=new Headers({"Location":"/","Cache-Control":"no-store"});
  headers.append("Set-Cookie",clear);
  headers.append("Set-Cookie",cookie("homeservice_oidc_session",session,{maxAge:Math.max(1,expiry-Math.floor(Date.now()/1000)),secure}));
  return new Response(null,{status:303,headers});
 }catch{return Response.json({error:"login failed"},{status:401,headers:{"Set-Cookie":clear}});}
}
