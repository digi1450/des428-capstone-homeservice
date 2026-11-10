import {oidcRequestUrl} from "#lib/security/oidc-origin.js";
import {createAuthorizationRequest} from "#lib/security/oidc-pkce.js";
import {seal,cookie} from "#lib/security/oidc-session.js";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(request){
 const issuer=process.env.KEYCLOAK_ISSUER,redirectUri=process.env.OIDC_REDIRECT_URI,secret=process.env.OIDC_SESSION_SECRET;
 if(process.env.OIDC_LOGIN_ENABLED!=="true"||!issuer||!redirectUri||!secret)return Response.json({error:"unavailable"},{status:503});
 try{
  const origin=oidcRequestUrl(request);
  if(new URL(redirectUri).origin!==origin.origin)return Response.json({error:"origin mismatch"},{status:503});
  const data=createAuthorizationRequest({issuer,redirectUri});
  if(origin.searchParams.get('signup')==='1'){
   if(process.env.OIDC_SELF_REGISTRATION_ENABLED!=='true')return Response.json({error:"registration unavailable"},{status:503});
   const register=new URL(data.url);register.pathname=register.pathname.replace(/\/auth$/,'/registrations');data.url=register.toString();
  }
  const secure=origin.protocol==="https:";
  if(!secure&&!["localhost","127.0.0.1"].includes(origin.hostname))return Response.json({error:"HTTPS required"},{status:503});
  const pending=seal({state:data.state,verifier:data.verifier,nonce:data.nonce,created:Date.now()},secret);
  return new Response(null,{status:302,headers:{Location:data.url,"Set-Cookie":cookie("homeservice_oidc_pending",pending,{maxAge:300,secure}),"Cache-Control":"no-store"}});
 }catch{return Response.json({error:"OIDC configuration invalid"},{status:503});}
}
