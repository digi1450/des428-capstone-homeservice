import {cookie} from "#lib/security/oidc-session.js";
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
 return Response.json({ok:true},{headers});
}
