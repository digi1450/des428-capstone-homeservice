import {readCookie} from "./oidc-session.js";
import {createOidcSessionStore,isOidcSessionId,oidcSessionPath} from "./oidc-session-store.js";
export function getServerOidcSession(request,{secret=process.env.OIDC_SESSION_SECRET,issuer=process.env.KEYCLOAK_ISSUER,path=oidcSessionPath(),now=Date.now}={}){
 if(!secret||!issuer)throw Error("OIDC session unavailable");
 const value=readCookie(request,"homeservice_oidc_session");
 if(!isOidcSessionId(value))return null;
 let session,store;
 try{store=createOidcSessionStore({path,secret,now});session=store.get(value);}finally{store?.close();}
 if(!session||session.issuer!==issuer||typeof session.sub!=="string"||!session.sub||
 !Number.isSafeInteger(session.exp)||session.exp<=Math.floor(now()/1000)||
 !["customer","provider","admin"].includes(session.role)||!Number.isInteger(session.domainId)||session.domainId<1||session.domainId>2147483647||
 typeof session.accessToken!=="string"||!session.accessToken)return null;
 // The server session's expiry must not outlive the signed access token.
 // Validate the token's expiry before forwarding; downstream services still verify its signature.
 const parts=session.accessToken.split(".");
 if(parts.length!==3||parts.some(part=>!part||part.length>8192||!/^[A-Za-z0-9_-]+$/.test(part)))return null;
 try{
  const claims=JSON.parse(Buffer.from(parts[1],"base64url").toString("utf8"));
  if(!Number.isSafeInteger(claims.exp)||claims.exp<=Math.floor(now()/1000)||claims.iss!==issuer||claims.sub!==session.sub||claims.azp!=="homeservice-web"||
    !(claims.aud==="notifications-service"||claims.aud==="payments-wallet-service"||(Array.isArray(claims.aud)&&claims.aud.some(x=>["notifications-service","payments-wallet-service"].includes(x)))))return null;
 }catch{return null;}
 return session;
}
export function getServiceUserAuthorization(request,options){
 const session=getServerOidcSession(request,options);
 if(!session)throw Error("OIDC user session required");
 // Server-only use. Never return the access token to a client component or JSON API.
 return {Authorization:"Bearer "+session.accessToken};
}
