import {freshBoot,getDb} from '../test-helpers/boot.js';
import {test} from 'node:test';import assert from 'node:assert/strict';
import {NodeSDK} from '@opentelemetry/sdk-node';
import {trace,ROOT_CONTEXT} from '@opentelemetry/api';
import {requestSpan,traceMetadata} from '../lib/telemetry/context.js';
import {createBookingFinalization,resetBookingFinalization,recoverFinalizationOnce} from '../lib/modules/booking/finalization.js';
const spans=[],sdk=new NodeSDK({autoDetectResources:false,instrumentations:[],metricReaders:[],logRecordProcessors:[],spanProcessors:[{onStart(){},onEnd(s){spans.push(s);},forceFlush:async()=>{},shutdown:async()=>{}}]});sdk.start();
test('durable financial recovery restores original trace/key after runtime replacement, isolates ambient context and marks failed attempts',async t=>{
 t.after(async()=>{resetBookingFinalization();await sdk.shutdown();});freshBoot();const db=getDb();
 const customerId=db.prepare('SELECT id FROM customers ORDER BY id LIMIT 1').get().id,providerId=db.prepare('SELECT id FROM providers ORDER BY id LIMIT 1').get().id;
 const orderId=Number(db.prepare("INSERT INTO orders (customer_id,provider_id,service_date,starting_time,ending_time,duration_min,subtotal_cents,tax_cents,total_cents,commission_pct,payment_method,otp) VALUES (?,?,'2027-03-01','10:00','10:30',30,10000,700,10700,10,'cod',123456)").run(customerId,providerId).lastInsertRowid);
 const calls=[];let fail=true;
 const financial={complete:async()=>{throw Error('unexpected completion');},cancel:async(work,credentials)=>{
  calls.push({work:structuredClone(work),credentials});if(fail)throw Error('fixture transport failure');
  return {kind:'cancellation',command_id:work.commandId,request:work.request,state:'ready',settlement_fenced:true,outcome:'no_payment'};
 }};
 const configure=()=>createBookingFinalization({financial,credentials:async()=>({token:'fixture-service-token',...traceMetadata()})});
 const api=configure(),traceId='1234567890abcdef1234567890abcdef';
 await requestSpan(new Request('https://app.example.test/api/bookings/'+orderId+'/cancel',{method:'POST',headers:{traceparent:'00-'+traceId+'-1234567890abcdef-01'}}),'recovery-request',async()=>api.cancel({orderId,customerId}));
 const original=db.prepare('SELECT * FROM booking_financial_work WHERE order_id=?').get(orderId),carrier=db.prepare('SELECT headers_json FROM booking_work_trace_context WHERE operation_id=?').get(original.operation_id).headers_json;
 assert.equal(original.state,'pending');assert.equal(original.attempts,1);assert.ok(!original.request_json.includes('traceparent'));assert.ok(!carrier.includes('fixture-service-token'));
 resetBookingFinalization();configure();fail=false;
 db.prepare("UPDATE booking_financial_work SET next_attempt_at='2000-01-01'").run();
 await trace.getTracer('fixture').startActiveSpan('unrelated ambient',{},ROOT_CONTEXT,async span=>{await recoverFinalizationOnce();span.end();});
 const done=db.prepare('SELECT * FROM booking_financial_work WHERE order_id=?').get(orderId);assert.equal(done.state,'ready');assert.equal(done.command_id,original.command_id);assert.equal(done.request_json,original.request_json);
 assert.deepEqual(calls[0].work,calls[1].work);assert.equal(calls[1].credentials.traceparent.split('-')[1],traceId);assert.equal(calls[1].credentials.requestId,'recovery-request');
 const attempts=spans.filter(s=>s.name==='booking financial delivery');assert.equal(attempts.length,2);assert.equal(attempts[0].status.code,2);assert.equal(attempts[1].attributes['booking.work.state'],'ready');assert.equal(attempts[0].parentSpanContext.spanId,attempts[1].parentSpanContext.spanId);assert.notEqual(attempts[0].spanContext().spanId,attempts[1].spanContext().spanId);
 assert.equal(db.prepare('SELECT headers_json FROM booking_work_trace_context WHERE operation_id=?').get(original.operation_id).headers_json,carrier);
});
