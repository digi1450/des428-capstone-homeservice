import {cookie,readCookie} from "#lib/security/oidc-session.js";
import {createOidcSessionStore,isOidcSessionId} from "#lib/security/oidc-session-store.js";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request){
 const url=new URL(request.url);
 const secure=url.protocol==="https:";
 const origin=request.headers.get("origin");
 if(!origin||origin!==url.origin)return Response.json({error:"origin required"},{status:403});
 const headers=new Headers({"Cache-Control":"no-store"});
 headers.append("Set-Cookie",cookie("homeservice_oidc_pending","",{maxAge:0,secure}));
 headers.append("Set-Cookie",cookie("homeservice_oidc_session","",{maxAge:0,secure}));
 const id=readCookie(request,"homeservice_oidc_session");
 if(isOidcSessionId(id)){
  let store;
  try{store=createOidcSessionStore();store.remove(id);}catch{return Response.json({error:"logout unavailable"},{status:503,headers});}finally{store?.close();}
 }
 return Response.json({ok:true},{headers});
}
