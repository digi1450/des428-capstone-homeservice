import {deploymentLegacyApproval} from '../security/legacy-checkpoint.js';
import {configureLegacyBookingApproval} from '../modules/booking/legacy-binding.js';
// Explicit, gated process boot. Defaults preserve the supplied legacy startup.
import {resolve} from 'node:path';
import {processState} from './process-state.js';
const state=processState('startup');
const dependencies=async()=>{
 const [db,auth,relay,broker,consumers]=await Promise.all([
  import('../db/bootstrap.js'),import('./authenticated-services.js'),
  import('../modules/notifications/relay.js'),import('../messaging/broker-relay.js'),import('../messaging/consumers.js'),
 ]);
 return {...db,...auth,...relay,...broker,...consumers};
};
export function startupConfiguration(env=process.env){
 const flag=env.AUTHENTICATED_SERVICES_ENABLED;
 if(flag!==undefined&&!['true','false'].includes(flag))throw new Error('Invalid AUTHENTICATED_SERVICES_ENABLED');
 const registration=env.OIDC_SELF_REGISTRATION_ENABLED;
 if(registration!==undefined&&!['true','false'].includes(registration))throw new Error('Invalid OIDC_SELF_REGISTRATION_ENABLED');
 if(registration==='true'&&flag!=='true')throw new Error('Keycloak signup requires integrated authenticated startup');
 if(flag!=='true'){
  if(env.LEGACY_CHECKPOINT_FILE||env.LEGACY_CHECKPOINT_PUBLIC_KEY_FILE)throw new Error('Legacy checkpoint requires integrated authenticated startup');
  return null;
 }
 if(env.AUTHENTICATED_CUTOVER_APPROVED!=='true')throw new Error('Authenticated startup requires the reviewed data/identity cutover gate');
 if(env.OIDC_LOGIN_ENABLED!=='true'||env.AREA_B_NOTIFICATIONS_PROXY==='true'||env.AREA_B_PAYMENTS_PROXY==='true')throw new Error('Integrated startup requires OIDC login and disabled proxy-only flags');
 for(const name of ['KEYCLOAK_ISSUER','PAYMENTS_WALLET_SERVICE_URL','NOTIFICATIONS_SERVICE_URL','BOOKING_SERVICE_CLIENT_SECRET','OIDC_SESSION_SECRET','IDENTITY_MAPPING_DB_PATH','OIDC_REDIRECT_URI','AMQP_URL']){
  if(typeof env[name]!=='string'||!env[name].trim())throw new Error(`Missing ${name}`);
 }
 for(const name of ['IDENTITY_MAPPING_DB_PATH','OIDC_SESSION_DB_PATH']){
  if(env[name]&&resolve(env[name])===resolve(env.DB_PATH||'data/edemand.db'))throw new Error('Identity/session sidecars must not use the Booking database');
 }
 const redirect=new URL(env.OIDC_REDIRECT_URI);
 if(redirect.protocol!=='https:'||redirect.username||redirect.password||redirect.search||redirect.hash||redirect.pathname!=='/api/auth/keycloak/callback')throw new Error('Trusted HTTPS OIDC callback required');
 const broker=new URL(env.AMQP_URL);
 if(!['amqp:','amqps:'].includes(broker.protocol))throw new Error('RabbitMQ URL required');
 return {legacyManifestSha256:deploymentLegacyApproval(env),issuer:env.KEYCLOAK_ISSUER,paymentsUrl:env.PAYMENTS_WALLET_SERVICE_URL,
  notificationsUrl:env.NOTIFICATIONS_SERVICE_URL,bookingClientSecret:env.BOOKING_SERVICE_CLIENT_SECRET,
  sessionSecret:env.OIDC_SESSION_SECRET,sessionDbPath:env.OIDC_SESSION_DB_PATH||env.IDENTITY_MAPPING_DB_PATH,
  identityMappingDbPath:env.IDENTITY_MAPPING_DB_PATH};
}
export function startApplication({env=process.env,load=dependencies}={}){
 // Cache the pending boot as well as the completed boot: parallel register calls cannot duplicate timers.
 if(state.value)return state.value;
 const pending=(async()=>{
  const config=startupConfiguration(env),deps=await load();
  if(globalThis[Symbol.for('edemand.broker-relay')]||globalThis[Symbol.for('edemand.event-consumers')])throw new Error('Stop existing broker workers before application boot');
  deps.bootstrapDb(); // never start workers against an invalid or reset database
  if(config?.legacyManifestSha256)configureLegacyBookingApproval(config.legacyManifestSha256);
  let runtime,broker,consumers;
  try{
   if(config)runtime=deps.configureAuthenticatedServices(config);
   else deps.startRelay();
   if(env.AMQP_URL){
    // Install subscriptions before starting the producer/recovery loops. These existing C
    // supervisors reconnect asynchronously; startup completion is NOT broker readiness.
    consumers=deps.startConsumers({amqpUrl:env.AMQP_URL});
    broker=deps.startBrokerRelay({amqpUrl:env.AMQP_URL});
   }
   runtime?.startRecovery();
   let stopped=false;
   const handle={mode:config?'authenticated':'legacy',async stop(){
    if(stopped)return;stopped=true;
    // HTTP must already be drained by the caller. Never use this to fall back during an outage.
    try{await runtime?.stop();}finally{
     try{await consumers?.stop();}finally{
      await broker?.stop();if(broker?.done)await broker.done;
      if(!config)deps.stopRelay();
      if(state.value===pending)state.value=null;
     }
    }
   }};
   return handle;
  }catch(error){
   await runtime?.stop();await consumers?.stop();await broker?.stop();
   if(!config)deps.stopRelay();
   throw error;
  }
 })();
 state.value=pending;
 pending.catch(()=>{if(state.value===pending)state.value=null;});
 return pending;
}
