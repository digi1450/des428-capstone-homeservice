import {unseal,readCookie} from "./oidc-session.js";
export function getServerOidcSession(request,{secret=process.env.OIDC_SESSION_SECRET,issuer=process.env.KEYCLOAK_ISSUER,now=Date.now}={}){
 if(!secret||!issuer)throw Error("OIDC session unavailable");
 const value=readCookie(request,"homeservice_oidc_session");
 if(!value) return null;
 let session;
 try{session=unseal(value,secret);}catch{return null;}
 if(!session||session.issuer!==issuer||typeof session.sub!=="string"||!session.sub||
 !Number.isSafeInteger(session.exp)||session.exp<=Math.floor(now()/1000)||
 !["customer","provider","admin"].includes(session.role)||!Number.isInteger(session.domainId)||session.domainId<1||session.domainId>2147483647||
 typeof session.accessToken!=="string"||!session.accessToken)return null;
 return session;
}
export function getServiceUserAuthorization(request,options){
 const session=getServerOidcSession(request,options);
 if(!session)throw Error("OIDC user session required");
 // Server-only use. Never return the access token to a client component or JSON API.
 return {Authorization:"Bearer "+session.accessToken};
}
