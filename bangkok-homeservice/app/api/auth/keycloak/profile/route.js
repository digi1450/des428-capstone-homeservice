import {handle} from '#lib/http/handle.js';
import {parse} from '#lib/http/validate.js';
import {getIdentityAccess} from '#lib/http/identity-access.js';
import {UnauthorizedError,ForbiddenError,AppError} from '#lib/errors.js';
import {oidcRequestUrl} from '#lib/security/oidc-origin.js';
import {getOnboardingSession,readOnboardingJson} from '#lib/security/oidc-onboarding.js';
import {createOidcSessionStore} from '#lib/security/oidc-session-store.js';
import {cookie,readCookie} from '#lib/security/oidc-session.js';
import {profileSchema,completeIdentityProfile} from '#lib/modules/identity/onboarding.js';
export const runtime='nodejs';export const dynamic='force-dynamic';
export const POST=handle(async request=>{
 if(!getIdentityAccess()||process.env.OIDC_LOGIN_ENABLED!=='true'||process.env.OIDC_SELF_REGISTRATION_ENABLED!=='true')throw new AppError(503,'Keycloak registration unavailable');
 const url=oidcRequestUrl(request);if(request.headers.get('origin')!==url.origin)throw new ForbiddenError('origin required');
 const pending=getOnboardingSession(request);if(!pending)throw new UnauthorizedError('Keycloak registration session required');
 const profile=parse(profileSchema,await readOnboardingJson(request));
 let identity;try{identity=completeIdentityProfile({issuer:pending.issuer,sub:pending.sub,email:pending.email},profile,{path:process.env.IDENTITY_MAPPING_DB_PATH});}catch(error){if(error instanceof AppError)throw error;throw new AppError(503,'profile setup unavailable; retry or sign in again');}
 let store,id;
 try{
  store=createOidcSessionStore();
  id=store.rotate(readCookie(request,'homeservice_oidc_onboarding'),{issuer:pending.issuer,sub:pending.sub,role:identity.role,domainId:identity.domainId,exp:pending.exp,accessToken:pending.accessToken,refreshToken:pending.refreshToken,nonce:pending.nonce});
 }finally{store?.close();}
 if(!id)throw new AppError(409,'registration session changed; log in again');
 const headers=new Headers({'Cache-Control':'no-store'}),secure=url.protocol==='https:';
 headers.append('Set-Cookie',cookie('homeservice_oidc_session',id,{secure,maxAge:Math.max(1,pending.exp-Math.floor(Date.now()/1000))}));
 headers.append('Set-Cookie',cookie('homeservice_oidc_onboarding','',{secure,maxAge:0}));
 return Response.json({ok:true,role:identity.role,redirectTo:identity.role==='provider'?'/provider/dashboard':'/'},{status:201,headers});
});
