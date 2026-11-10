import {oidcRequestUrl} from "./oidc-origin.js";
import {cookie,readCookie} from "./oidc-session.js";
import {createOidcSessionStore,isOidcSessionId} from "./oidc-session-store.js";
export async function logoutOidcSession(request,{path,secret}={}){
 let url;try{url=oidcRequestUrl(request);}catch{return Response.json({error:"origin mismatch"},{status:503});}
 const secure=url.protocol==="https:";
 const origin=request.headers.get("origin");
 if(!origin||origin!==url.origin)return Response.json({error:"origin required"},{status:403});
 const headers=new Headers({"Cache-Control":"no-store"});
 headers.append("Set-Cookie",cookie("homeservice_oidc_pending","",{maxAge:0,secure}));
 headers.append("Set-Cookie",cookie("homeservice_oidc_session","",{maxAge:0,secure}));
 const pending=readCookie(request,"homeservice_oidc_onboarding");
 if(pending)headers.append("Set-Cookie",cookie("homeservice_oidc_onboarding","",{maxAge:0,secure}));
 const id=readCookie(request,"homeservice_oidc_session");
 if(isOidcSessionId(id)||isOidcSessionId(pending)){
  let store;
  try{store=createOidcSessionStore({path,secret});store.remove(id);store.remove(pending);}catch{return Response.json({error:"logout unavailable"},{status:503,headers});}finally{store?.close();}
 }
 return Response.json({ok:true},{headers});
}
