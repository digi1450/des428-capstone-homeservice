import {readCookie} from './oidc-session.js';
import {createOidcSessionStore} from './oidc-session-store.js';
export function getOnboardingSession(request,{path,secret,issuer=process.env.KEYCLOAK_ISSUER}={}){
 if(process.env.OIDC_SELF_REGISTRATION_ENABLED!=='true')return null;
 let store;
 try{
  store=createOidcSessionStore({path,secret});
  const value=store.get(readCookie(request,'homeservice_oidc_onboarding'));
  if(value?.purpose!=='onboarding'||value.issuer!==issuer||typeof value.sub!=='string'||!value.sub||typeof value.email!=='string'||typeof value.accessToken!=='string')return null;
  return value;
 }finally{store?.close();}
}

// Bound the new authenticated profile input before parsing/validation.
export async function readOnboardingJson(request){
 const {AppError,BadRequestError}=await import('../errors.js');
 if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'||!['identity',null].includes(request.headers.get('content-encoding')))throw new AppError(415,'application/json required');
 if(Number(request.headers.get('content-length'))>16384)throw new AppError(413,'profile body too large');
 if(!request.body)return {};
 const reader=request.body.getReader(),chunks=[];let length=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>16384)throw new AppError(413,'profile body too large');chunks.push(value);}}
 finally{try{await reader.cancel();}catch{}}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new BadRequestError('invalid profile JSON');}
}
