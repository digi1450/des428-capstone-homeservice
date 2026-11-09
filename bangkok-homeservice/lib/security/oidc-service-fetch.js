import {getServiceUserAuthorization} from "./oidc-server-session.js";
const allowedServices=new Set(["notifications","payments-wallet"]);
export async function fetchAsOidcUser(request,{service,url,method="GET",body,fetchImpl=fetch,sessionOptions}={}){
 if(!allowedServices.has(service))throw Error("unsupported service");
 const configured=service==="notifications"?process.env.NOTIFICATIONS_SERVICE_URL:process.env.PAYMENTS_WALLET_SERVICE_URL;
 if(!configured)throw Error("service URL not configured");
 const origin=new URL(configured);
 if(origin.username||origin.password||origin.search||origin.hash||!["https:","http:"].includes(origin.protocol))throw Error("invalid service URL");
 if(origin.protocol!=="https:"&&!["localhost","127.0.0.1"].includes(origin.hostname))throw Error("TLS required for service URL");
 const target=new URL(url,origin);
 if(target.origin!==origin.origin||!target.pathname.startsWith("/api/"))throw Error("invalid service target");
 if(!["GET","POST","PUT","PATCH","DELETE"].includes(method))throw Error("invalid method");
 const auth=getServiceUserAuthorization(request,sessionOptions);
 const headers={...auth,Accept:"application/json"};
 if(body!==undefined)headers["Content-Type"]="application/json";
 return fetchImpl(target,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:"error",signal:AbortSignal.timeout(5000),cache:"no-store"});
}
