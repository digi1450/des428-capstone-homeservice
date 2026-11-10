import test from 'node:test';
import assert from 'node:assert/strict';
import {startApplication,startupConfiguration} from '../lib/runtime/startup.js';
const env={AUTHENTICATED_SERVICES_ENABLED:'true',AUTHENTICATED_CUTOVER_APPROVED:'true',OIDC_LOGIN_ENABLED:'true',KEYCLOAK_ISSUER:'https://id.example.test/realms/homeservice',PAYMENTS_WALLET_SERVICE_URL:'https://payments.example.test',NOTIFICATIONS_SERVICE_URL:'https://notes.example.test',BOOKING_SERVICE_CLIENT_SECRET:'fixture',OIDC_SESSION_SECRET:'s'.repeat(32),IDENTITY_MAPPING_DB_PATH:'/tmp/fixture-bindings.sqlite',OIDC_REDIRECT_URI:'https://app.example.test/api/auth/keycloak/callback',AMQP_URL:'amqp://fixture:fixture@broker'};
function fixture(fail){
 const calls=[];
 const deps={bootstrapDb(){calls.push('db');if(fail==='db')throw Error('incompatible');},
 configureAuthenticatedServices(config){calls.push('configure');assert.equal(config.issuer,env.KEYCLOAK_ISSUER);return {startRecovery(){calls.push('recovery');if(fail==='recovery')throw Error('recovery failed');},async stop(){calls.push('runtime-stop');}};},
 startRelay(){calls.push('legacy');},stopRelay(){calls.push('legacy-stop');},
 startConsumers(){calls.push('consumers');return {async stop(){calls.push('consumers-stop');}};},
 startBrokerRelay(){calls.push('broker');return {async stop(){calls.push('broker-stop');},done:Promise.resolve()};}};
 return {calls,load:async()=>deps};
}
test('startup gates, ordering, shared ownership and failure behavior',async t=>{
 await t.test('default legacy startup and process-wide idempotence',async()=>{
  const f=fixture(),a=startApplication({env:{},load:f.load}),b=startApplication({env:{},load:f.load});assert.equal(a,b);
  const duplicate=await import('../lib/runtime/startup.js?other-bundle');assert.equal(duplicate.startApplication({env:{},load:f.load}),a);
  const app=await a;assert.equal(app.mode,'legacy');assert.deepEqual(f.calls,['db','legacy']);await app.stop();assert.deepEqual(f.calls,['db','legacy','legacy-stop']);
 });
 await t.test('missing cutover or conflicting proxy fails before DB/workers',async()=>{
  for(const invalid of [{AUTHENTICATED_CUTOVER_APPROVED:'false'},{OIDC_LOGIN_ENABLED:'false'},{AREA_B_PAYMENTS_PROXY:'true'},{AMQP_URL:''},{DB_PATH:env.IDENTITY_MAPPING_DB_PATH},{OIDC_REDIRECT_URI:'http://app.example.test/api/auth/keycloak/callback'}]){
   const f=fixture();await assert.rejects(startApplication({env:{...env,...invalid},load:f.load}));assert.deepEqual(f.calls,[]);
  }
  assert.throws(()=>startupConfiguration({AUTHENTICATED_SERVICES_ENABLED:'yes'}));
 });
 await t.test('authenticated boot selects clients before workers, no legacy relay, one recovery',async()=>{
  const f=fixture(),app=await startApplication({env,load:f.load});assert.equal(app.mode,'authenticated');assert.deepEqual(f.calls,['db','configure','consumers','broker','recovery']);await app.stop();await app.stop();assert.deepEqual(f.calls.slice(5),['runtime-stop','consumers-stop','broker-stop']);
 });
 await t.test('preexisting broker workers are not adopted or stopped',async()=>{
  const key=Symbol.for('edemand.event-consumers'),f=fixture();globalThis[key]={foreign:true};
  try{await assert.rejects(startApplication({env,load:f.load}),/Stop existing/);assert.deepEqual(f.calls,[]);}finally{delete globalThis[key];}
 });
 await t.test('incompatible DB never starts anything else',async()=>{
  const f=fixture('db');await assert.rejects(startApplication({env,load:f.load}),/incompatible/);assert.deepEqual(f.calls,['db']);
 });
 await t.test('partial boot failure drains owned runtime/workers; no legacy fallback',async()=>{
  const f=fixture('recovery');await assert.rejects(startApplication({env,load:f.load}),/recovery failed/);assert.deepEqual(f.calls,['db','configure','consumers','broker','recovery','runtime-stop','consumers-stop','broker-stop']);
 });
});

test('independently evaluated module copies share all runtime cells',async()=>{
 const cases=[['http/identity-access.js','getIdentityAccess','resetIdentityAccess'],['modules/booking/saga.js','getBookingSaga','resetBookingSaga'],['modules/booking/finalization.js','getBookingFinalizationRuntime','resetBookingFinalization'],['modules/booking/financial-state.js','getBookingFinancialAccess','resetBookingFinancialAccess'],['modules/payments/access.js','getPaymentsAccess','resetPaymentsAccess'],['modules/payments/webhook-access.js','getWebhookAccess','resetWebhookAccess'],['modules/providers/event-writes.js','getProviderEventWrites','resetProviderEventWrites'],['modules/notifications/access.js','getNotificationsAccess','resetNotificationsAccess'],['modules/notifications/relay.js','getNotificationEventDelivery','resetNotificationEventDelivery']];
 for(const [path,get,reset]of cases){
  const a=await import('../lib/'+path),b=await import('../lib/'+path+'?bundle-copy');
  const key=Symbol.for('edemand.runtime.'+path),marker={fixture:true};
  assert.equal(a[get](),null);globalThis[key].value=marker;
  try{assert.equal(a[get](),marker);assert.equal(b[get](),marker);b[reset]();assert.equal(a[get](),null);}finally{a[reset]();}
 }
});


test('typed runtime errors retain HTTP status across independently evaluated bundles',async()=>{
 const errors=await import('../lib/errors.js?instrumentation-copy');
 const {toResponse}=await import('../lib/http/respond.js');
 assert.equal(toResponse(new errors.UnauthorizedError('removed mapping'),'fixture').status,401);
 assert.equal(toResponse(new errors.AppError(503,'remote unavailable'),'fixture').status,503);
 assert.equal(toResponse(Object.assign(new Error('untrusted error'),{statusCode:401}),'fixture').status,500);
});
