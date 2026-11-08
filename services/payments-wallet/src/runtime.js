// Composition of A business/HTTP and C consistency. B supplies the real verifiers;
// absence leaves both protected HTTP boundaries unavailable, never header-trusted.
import {createApp} from './app.js';
import {createPaymentsService} from './service.js';
import {createPaymentParticipant} from './participant/index.js';
import {createOutbox} from './messaging/outbox.js';
import {paymentEventContext} from './request-context.js';
export function createPaymentsRuntime({database,authenticate,authenticateService}={}){
  if(!database || typeof database.query!=='function' || typeof database.withTransaction!=='function') throw new TypeError('Payments runtime requires its owning database');
  const provided=authenticate!==undefined || authenticateService!==undefined;
  if(provided && (typeof authenticate!=='function' || typeof authenticateService!=='function')) throw new TypeError('Payments runtime requires both user and service verifiers');
  const outbox=createOutbox();
  let participant;
  const paymentHooks={
    assertSettlementAllowed:(client,intent)=>participant.assertSettlementAllowed(client,intent),
    stageEvent:(client,event)=>outbox.stage(client,event,paymentEventContext()),
  };
  const business=createPaymentsService(database,paymentHooks);
  participant=createPaymentParticipant({database,business});
  const app=createApp({database,authenticate,authenticateService,paymentCommands:participant,paymentHooks});
  return {app,business,participant};
}
