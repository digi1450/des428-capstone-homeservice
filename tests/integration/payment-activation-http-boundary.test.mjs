// Actual Booking adapter/client -> Payments HTTP -> C participant -> disposable PostgreSQL.
// Authentication is an explicit test double; no live saga, Keycloak or SQLite worker is enabled.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomInt,randomUUID} from 'node:crypto';
import {createDatabase} from '../../services/payments-wallet/src/database.js';
import {migrate} from '../../services/payments-wallet/src/migrations.js';
import {createPaymentsService} from '../../services/payments-wallet/src/service.js';
import {createPaymentParticipant} from '../../services/payments-wallet/src/participant/index.js';
import {createApp} from '../../services/payments-wallet/src/app.js';
import {HttpError} from '../../services/payments-wallet/src/errors.js';
import {createPaymentsClient,PaymentOutcomeUnknownError,PaymentSetupCancelledError,PaymentActivationConflictError} from '../../bangkok-homeservice/lib/modules/payments/client.js';
import {createBookingPaymentsAdapter} from '../../bangkok-homeservice/lib/modules/booking/payment-adapter.js';

test('actual activation adapter/HTTP/participant interoperability and stable recovery',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const db=createDatabase(process.env.TEST_DATABASE_URL), caller='activation-boundary|'+randomUUID();
 const base=randomInt(100000000,150000000), orders=[];let count=0;const servers=[],requests=[];
 const credentials={token:'activation-boundary-token',requestId:'activation-boundary',traceparent:'00-11111111111111111111111111111111-2222222222222222-01'};
 const next=()=>{const id=base+(++count);orders.push(id);return {order:{id,customer_id:7,provider_id:3,total_cents:1500,payment_method:'gateway'},workflow:{createCommandId:`create:boundary-${id}`,sagaId:`saga-boundary-${id}`,activateCommandId:`activate:boundary-${id}`}};};
 const listen=async app=>{const server=app.listen(0,'127.0.0.1');servers.push(server);await new Promise(resolve=>server.once('listening',resolve));return `http://127.0.0.1:${server.address().port}`;};
 try {
  await migrate(db);
  const participant=createPaymentParticipant({database:db,business:createPaymentsService(db)});
  const url=await listen(createApp({database:db,paymentCommands:participant,authenticateService:async(req,{operation})=>{
   if(req.get('authorization')!=='Bearer activation-boundary-token')throw new HttpError(401,'invalid test token');
   requests.push({operation,key:req.get('Idempotency-Key'),body:structuredClone(req.body),requestId:req.requestId});
   return {service:'booking',callerId:caller};
  }}));
  // Record raw HTTP metadata here because authorization runs before the JSON parser.
  const calls=[];
  const recordingFetch=(input,options)=>{calls.push({url:String(input),body:options.body,key:options.headers['Idempotency-Key']});return fetch(input,options);};
  const client=createPaymentsClient({baseUrl:url,fetchImpl:recordingFetch});
  const adapter=createBookingPaymentsAdapter({paymentsClient:client});
  await t.test('prepare then fresh/replayed activation binds the same identifiers and persists one command',async()=>{
   const p=next();await adapter.prepare(p.order,p.workflow,credentials);
   const result=await adapter.activate(p.workflow,credentials);
   assert.deepEqual(result,{create_command_id:p.workflow.createCommandId,saga_id:p.workflow.sagaId,outcome:'activated'});
   assert.deepEqual(await adapter.activate(p.workflow,credentials),result);
   assert.deepEqual(calls.at(-1),calls.at(-2));
   assert.equal(requests.at(-1).operation,'activate');assert.equal(requests.at(-1).requestId,credentials.requestId);
   assert.equal((await db.query('SELECT count(*)::int AS n FROM payment_commands WHERE caller_id=$1 AND command_id=$2',[caller,p.workflow.activateCommandId])).rows[0].n,1);
  });
  await t.test('lost successful reply is unknown; explicit same-key retry converges without repeating effects',async()=>{
   const p=next();await adapter.prepare(p.order,p.workflow,credentials);
   let lose=true;const calls=[];
   const lossy=createBookingPaymentsAdapter({paymentsClient:createPaymentsClient({baseUrl:url,fetchImpl:async(input,options)=>{
    calls.push({body:options.body,key:options.headers['Idempotency-Key']});const response=await fetch(input,options);
    if(lose){lose=false;assert.equal(response.status,200);await response.arrayBuffer();throw new Error('simulated lost reply after commit');}return response;
   }})});
   await assert.rejects(lossy.activate(p.workflow,credentials),error=>error instanceof PaymentOutcomeUnknownError&&error.operation==='activate');
   assert.equal(calls.length,1);
   assert.equal((await db.query('SELECT state FROM payment_provisioning WHERE caller_id=$1 AND create_command_id=$2',[caller,p.workflow.createCommandId])).rows[0].state,'activated');
   assert.equal((await lossy.activate(p.workflow,credentials)).outcome,'activated');assert.deepEqual(calls[0],calls[1]);
   assert.equal((await db.query('SELECT count(*)::int AS n FROM payment_commands WHERE caller_id=$1 AND command_id=$2',[caller,p.workflow.activateCommandId])).rows[0].n,1);
  });
  await t.test('uncoded conflict is reconciliation; a later fence overrides historical activation acceptance',async()=>{
   const p=next();
   await assert.rejects(adapter.activate(p.workflow,credentials),error=>error instanceof PaymentActivationConflictError&&error.code===undefined);
   await adapter.prepare(p.order,p.workflow,credentials);await adapter.activate(p.workflow,credentials);
   await adapter.cancel({createCommandId:p.workflow.createCommandId,sagaId:p.workflow.sagaId,cancelCommandId:`cancel:${p.order.id}`,reason:'booking_setup_failed'},credentials);
   await assert.rejects(adapter.activate(p.workflow,credentials),error=>error instanceof PaymentSetupCancelledError&&error.statusCode===409&&error.code==='PAYMENT_SETUP_CANCELLED'&&error.commandId===p.workflow.activateCommandId);
   assert.equal((await db.query('SELECT state FROM payment_provisioning WHERE caller_id=$1 AND create_command_id=$2',[caller,p.workflow.createCommandId])).rows[0].state,'fenced');
   assert.equal((await db.query('SELECT status FROM payment_intents WHERE order_id=$1',[p.order.id])).rows[0].status,'failed');
  });
  await t.test('unwired default production composition remains unavailable and unknown',async()=>{
   const defaultUrl=await listen(createApp({database:db}));const p=next();
   const unwired=createBookingPaymentsAdapter({paymentsClient:createPaymentsClient({baseUrl:defaultUrl})});
   await assert.rejects(unwired.activate(p.workflow,credentials),error=>error instanceof PaymentOutcomeUnknownError&&error.upstreamStatus===503);
  });
 }finally{
  for(const server of servers){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  try{await db.query('DELETE FROM payment_commands WHERE caller_id=$1',[caller]);await db.query('DELETE FROM payment_provisioning WHERE caller_id=$1',[caller]);await db.query('DELETE FROM payment_intents WHERE order_id=ANY($1::integer[])',[orders]);}finally{await db.close();}
 }
});
