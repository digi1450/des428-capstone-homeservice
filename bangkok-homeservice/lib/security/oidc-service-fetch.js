import {getServiceUserAuthorization} from "./oidc-server-session.js";
const allowedServices=new Set(["notifications","payments-wallet"]);
const methods=new Set(["GET","POST","PUT","PATCH","DELETE"]);
export async function fetchAsOidcUser(request,{service,url,method="GET",body,fetchImpl=fetch,sessionOptions}={}){
 if(!allowedServices.has(service))throw Error("unsupported service");
 const configured=service==="notifications"?process.env.NOTIFICATIONS_SERVICE_URL:process.env.PAYMENTS_WALLET_SERVICE_URL;
 if(!configured)throw Error("service URL not configured");
 const origin=new URL(configured);
 if(origin.username||origin.password||origin.search||origin.hash||origin.pathname!=="/"||!["https:","http:"].includes(origin.protocol))throw Error("invalid service URL");
 if(origin.protocol!=="https:"&&!["localhost","127.0.0.1"].includes(origin.hostname))throw Error("TLS required for service URL");
 if(typeof url!=="string"||!url.startsWith("/api/")||url.startsWith("//")||url.includes("\\")||url.includes("#")||url.includes("?")||url.split("/").some(x=>x==="."||x===".."||/%2f|%5c|%2e/i.test(x)))throw Error("invalid service target");
 const target=new URL(url,origin);
 if(target.origin!==origin.origin||!target.pathname.startsWith("/api/"))throw Error("invalid service target");
 if(!methods.has(method))throw Error("invalid method");
 const auth=getServiceUserAuthorization(request,sessionOptions);
 // Match the JWT audience to the specific service receiving the bearer.
 const jwt=auth.Authorization.slice(7).split(".");
 let claims;
 try{claims=JSON.parse(Buffer.from(jwt[1],"base64url").toString("utf8"));}catch{throw Error("invalid access token");}
 const audience=service==="notifications"?"notifications-service":"payments-wallet-service";
 if(!(claims.aud===audience||(Array.isArray(claims.aud)&&claims.aud.includes(audience))))throw Error("token not intended for service");
 const headers={...auth,Accept:"application/json"};
 if(body!==undefined)headers["Content-Type"]="application/json";
 return fetchImpl(target,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:"error",signal:AbortSignal.timeout(5000),cache:"no-store"});
}
