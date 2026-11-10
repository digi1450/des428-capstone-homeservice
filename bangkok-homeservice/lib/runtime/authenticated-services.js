import {recoverIdentityBindings} from '../modules/identity/onboarding.js';
import {traceMetadata} from '../telemetry/context.js';
// Explicit composition, deliberately NOT called by default instrumentation/startup.
// A owns transport/lifecycle; B owns credentials/identity; C owns durable recovery.
import {createServiceTokenProvider} from '../security/service-token.js';
import {logoutOidcSession} from '../security/oidc-logout.js';
import {getServerOidcSession} from '../security/oidc-server-session.js';
import {createIdentityMappingStore} from '../security/identity-mapping.js';
import {createOidcSessionStore} from '../security/oidc-session-store.js';
import {getMe} from '../modules/identity/service.js';
import {configureIdentityAccess,getIdentityAccess,resetIdentityAccess} from '../http/identity-access.js';
import {createPaymentsClient} from '../modules/payments/client.js';
import {createFinancialClient} from '../modules/payments/financial-client.js';
import {createNotificationsClient} from '../modules/notifications/client.js';
import {configureBookingPaymentsRuntime} from '../modules/booking/payment-runtime.js';
import {getBookingSaga,resetBookingSaga,recoverOnce} from '../modules/booking/saga.js';
import {getPaymentsAccess,resetPaymentsAccess} from '../modules/payments/access.js';
import {createBookingFinalization,getBookingFinalizationRuntime,resetBookingFinalization,recoverFinalizationOnce} from '../modules/booking/finalization.js';
import {configureBookingFinancialAccess,getBookingFinancialAccess,resetBookingFinancialAccess} from '../modules/booking/financial-state.js';
import {configureNotificationsAccess,getNotificationsAccess,resetNotificationsAccess} from '../modules/notifications/access.js';
import {configureWebhookAccess,getWebhookAccess,resetWebhookAccess} from '../modules/payments/webhook-access.js';
import {configureProviderEventWrites,getProviderEventWrites,resetProviderEventWrites} from '../modules/providers/event-writes.js';
import {configureNotificationEventDelivery,getNotificationEventDelivery,resetNotificationEventDelivery} from '../modules/notifications/relay.js';
import {AppError,UnauthorizedError,ForbiddenError} from '../errors.js';
import {logger} from '../logger.js';

const origin=(value)=>{
 const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new TypeError('Trusted HTTPS service origin required');
 return url.origin;
};
const metadata=request=>{
 const out={};
 for(const [key,header,pattern]of [['requestId','x-request-id',/^[A-Za-z0-9._:-]{1,128}$/],['traceparent','traceparent',/^[\x20-\x7e]{1,512}$/],['tracestate','tracestate',/^[\x20-\x7e]{1,512}$/]]){
  const value=request?.headers?.get(header);if(typeof value==='string'&&pattern.test(value))out[key]=value;
 }
 return out;
};
const pageRequest=async()=>({headers:(await import('next/headers.js')).headers()});

export function configureAuthenticatedServices({issuer,paymentsUrl,notificationsUrl,bookingClientSecret,
 sessionSecret,sessionDbPath,identityMappingDbPath,requestProvider=pageRequest,fetchImpl=fetch,
 timeoutMs=2000,recoveryIntervalMs=2000,sagaOptions={},finalizationOptions={}}={}){
 const idp=new URL(issuer);
 if(idp.protocol!=='https:'||idp.username||idp.password||idp.search||idp.hash||!/^\/realms\/[^/]+$/.test(idp.pathname)||idp.href!==issuer)throw new TypeError('Trusted Keycloak realm issuer required');
 const paymentsOrigin=origin(paymentsUrl),notificationsOrigin=origin(notificationsUrl);
 if(!bookingClientSecret||typeof bookingClientSecret!=='string'||typeof sessionSecret!=='string'||sessionSecret.length<32||!sessionDbPath||!identityMappingDbPath||typeof requestProvider!=='function')throw new TypeError('Complete B credentials, persistent sidecars and request provider required');
 if(!Number.isInteger(recoveryIntervalMs)||recoveryIntervalMs<1||recoveryIntervalMs>60000)throw new TypeError('Invalid recovery interval');
 const finalKeys=new Set(['baseBackoffMs','maxBackoffMs','leaseMs','escalateAfter']);
 if(!finalizationOptions||Object.getPrototypeOf(finalizationOptions)!==Object.prototype||Object.entries(finalizationOptions).some(([k,v])=>!finalKeys.has(k)||!Number.isSafeInteger(v)||v<1)||(finalizationOptions.maxBackoffMs??30000)<(finalizationOptions.baseBackoffMs??1000))throw new TypeError('Invalid finalization options');
 if([getIdentityAccess(),getBookingSaga(),getPaymentsAccess(),getBookingFinancialAccess(),getBookingFinalizationRuntime(),getNotificationsAccess(),getWebhookAccess(),getProviderEventWrites(),getNotificationEventDelivery(),globalThis[Symbol.for('edemand.booking-saga.recovery')],globalThis[Symbol.for('edemand.relay.interval')]].some(Boolean))throw new Error('Drain/stop existing runtimes before configuring authenticated services');
 // Validate local B stores and all clients before selecting any global ownership.
 let store;
 try{store=createOidcSessionStore({path:sessionDbPath,secret:sessionSecret});}finally{store?.close();}
 try{store=createIdentityMappingStore({path:identityMappingDbPath});}finally{store?.close();}
 const paymentsClient=createPaymentsClient({baseUrl:paymentsOrigin,timeoutMs,fetchImpl});
 const financialClient=createFinancialClient({baseUrl:paymentsOrigin,timeoutMs,fetchImpl});
 const notificationsClient=createNotificationsClient({baseUrl:notificationsOrigin,timeoutMs,fetchImpl});
 const bookingCredentials=createServiceTokenProvider({tokenUrl:issuer+'/protocol/openid-connect/token',clientId:'booking-service',clientSecret:bookingClientSecret,fetchImpl});
 let closed=false,timer=null,inFlight=null,started=false;
 const active=()=>{if(closed)throw new AppError(503,'authenticated services stopped');};
 const session=request=>{
  active();const value=getServerOidcSession(request,{secret:sessionSecret,issuer,path:sessionDbPath});
  if(!value)return null;
  let bindings,bound;
  try{bindings=createIdentityMappingStore({path:identityMappingDbPath});bound=bindings.lookup({issuer,sub:value.sub});}finally{bindings?.close();}
  if(!bound||bound.role!==value.role||bound.domainId!==value.domainId)throw new UnauthorizedError('OIDC identity binding unavailable');
  return value;
 };
 const credentialsFor=audience=>async(auth,context)=>{
  const request=context===undefined?await requestProvider():context;
  const value=session(request);
  if(!value)throw new UnauthorizedError('OIDC user session required');
  if(value.role!==auth?.role||value.domainId!==auth?.sub)throw new ForbiddenError('request identity does not match caller');
  const claims=JSON.parse(Buffer.from(value.accessToken.split('.')[1],'base64url').toString('utf8'));
  if(!(claims.aud===audience||(Array.isArray(claims.aud)&&claims.aud.includes(audience))))throw new UnauthorizedError('token not intended for service');
  return {token:value.accessToken,...metadata(request),...traceMetadata()};
 };
 const userCredentials=credentialsFor('payments-wallet-service');
 const serviceCredentials=async()=>{active();return {...await bookingCredentials(),...traceMetadata()};}; // no browser authority, including recovery
 const cleanup=[],owned=[];
 const select=(configure,get,reset,arg)=>{const value=configure(arg);owned.push(()=>get()===value);cleanup.push(()=>{if(get()===value)reset();});return value;};
 let booking;
 try{
  booking=configureBookingPaymentsRuntime({paymentsClient,serviceCredentials,userCredentials,sagaOptions,recoveryIntervalMs});
  owned.push(()=>getBookingSaga()===booking.saga&&getPaymentsAccess()===booking.access);
  cleanup.push(()=>{if(getPaymentsAccess()===booking.access)resetPaymentsAccess();if(getBookingSaga()===booking.saga)resetBookingSaga();});
  const callbacks=createBookingFinalization({financial:financialClient,credentials:serviceCredentials,...finalizationOptions});
  const finalRuntime=getBookingFinalizationRuntime();owned.push(()=>getBookingFinalizationRuntime()===finalRuntime);
  cleanup.push(()=>{if(getBookingFinalizationRuntime()===finalRuntime)resetBookingFinalization();});
  select(configureBookingFinancialAccess,getBookingFinancialAccess,resetBookingFinancialAccess,{bookingFinalization:callbacks});
  select(configureNotificationsAccess,getNotificationsAccess,resetNotificationsAccess,{notificationsClient,credentials:credentialsFor('notifications-service')});
  select(configureWebhookAccess,getWebhookAccess,resetWebhookAccess,{financialClient,credentials:async request=>{
   active();const header=request?.headers?.get('authorization')??'';
   if(!/^Bearer [^\s]+$/.test(header))throw new UnauthorizedError('gateway bearer required');
   // Forward the original callback bearer. NEVER mint privileged gateway credentials
   // for an arbitrary incoming event. Payments B verifier authorizes the real caller.
   return {token:header.slice(7),...metadata(request),...traceMetadata()};
  }});
  select(configureIdentityAccess,getIdentityAccess,resetIdentityAccess,{logout:request=>logoutOidcSession(request,{path:sessionDbPath,secret:sessionSecret}),read:request=>{
   const value=session(request);if(!value)return null;
   const actor={sub:value.domainId,role:value.role};
   return {...actor,email:getMe(actor).email};
  }});
  select(configureProviderEventWrites,getProviderEventWrites,resetProviderEventWrites,{mode:'events'});
  select(configureNotificationEventDelivery,getNotificationEventDelivery,resetNotificationEventDelivery,{mode:'events'});
 }catch(error){closed=true;for(const undo of cleanup.reverse())undo();throw error;}
 const owns=()=>owned.every(check=>check());
 const recoverNow=()=>{
  active();if(!owns())throw new Error('authenticated runtime ownership changed');
  if(inFlight)return inFlight;
  inFlight=(async()=>{
   for(const recover of [recoverOnce,recoverFinalizationOnce,...(process.env.OIDC_SELF_REGISTRATION_ENABLED==='true'?[()=>recoverIdentityBindings({path:identityMappingDbPath})]:[])]){
    try{await recover();}catch(error){logger.error({kind:String(error?.name??'error').slice(0,80)},'authenticated recovery round failed');}
   }
  })().finally(()=>{inFlight=null;});
  return inFlight;
 };
 const schedule=()=>{timer=setTimeout(async()=>{
  timer=null;if(closed||!owns())return;
  try{await recoverNow();}finally{if(!closed&&owns())schedule();}
 },recoveryIntervalMs);timer.unref?.();};
 return {
  paymentsClient,financialClient,notificationsClient,userCredentials,recoverNow,
  startRecovery(){active();if(!owns())throw new Error('authenticated runtime ownership changed');if(!started){started=true;schedule();}},
  async stop(){closed=true;if(timer)clearTimeout(timer);timer=null;if(inFlight)await inFlight;for(const undo of cleanup.reverse())undo();},
 };
}
