import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
const require=createRequire(new URL('../../services/payments-wallet/package.json',import.meta.url));
const {NodeSDK}=require('@opentelemetry/sdk-node');
const {trace}=require('@opentelemetry/api');

// Opt-in: use a disposable broker. No useful database, queue deletion or real auth is needed.
test('persisted request context -> real RabbitMQ publish -> Notifications processing span',{skip:!process.env.TEST_AMQP_URL},async()=>{
 process.env.OTEL_METRICS_EXPORTER='none';process.env.OTEL_LOGS_EXPORTER='none';
 const spans=[];
 const sdk=new NodeSDK({autoDetectResources:false,instrumentations:[],spanProcessors:[{
  onStart(){},onEnd(span){spans.push(span);},forceFlush:async()=>{},shutdown:async()=>{},
 }]});
 await sdk.start();
 // Match worker startup: initialize OTel before importing the instrumented modules.
 const {createPublisher}=await import('../../services/payments-wallet/src/messaging/publisher.js');
 const {startConsumer}=await import('../../services/notifications/src/messaging/consumer.js');
 const traceId='1234567890abcdef1234567890abcdef',parentId='1234567890abcdef',eventId=randomUUID();
 let consumer,publisher,timer,seen;
 const received=new Promise((resolve,reject)=>{seen=resolve;timer=setTimeout(()=>reject(new Error('trace fixture was not consumed')),5000);});
 try{
  consumer=await startConsumer({amqpUrl:process.env.TEST_AMQP_URL,inbox:{handle:async envelope=>{
   if(envelope.event_id===eventId)seen(trace.getActiveSpan().spanContext());
   return {duplicate:false,effects:1};
  }}});
  publisher=await createPublisher(process.env.TEST_AMQP_URL);
  const row={event_id:eventId,event_type:'payment.succeeded',headers:{traceparent:`00-${traceId}-${parentId}-01`,'x-request-id':'trace-fixture'},envelope:{
   event_id:eventId,event_type:'payment.succeeded',schema_version:1,producer:'payments-wallet',occurred_at:new Date().toISOString(),
   aggregate_type:'order',aggregate_id:'42',saga_id:null,correlation_id:null,data:{order_id:42,customer_id:1,provider_id:2,amount_cents:107},
  }};
  await publisher.publish(row);
  const active=await received;assert.equal(active.traceId,traceId);
  for(let i=0;i<100&&!spans.some(s=>s.name==='rabbitmq process');i++)await new Promise(r=>setTimeout(r,10));
  const published=spans.find(s=>s.name==='rabbitmq publish'),processed=spans.find(s=>s.name==='rabbitmq process');
  assert.ok(published);assert.ok(processed);
  assert.equal(published.spanContext().traceId,traceId);assert.equal(published.parentSpanContext.spanId,parentId);
  assert.equal(processed.spanContext().traceId,traceId);assert.equal(processed.parentSpanContext.spanId,published.spanContext().spanId);
  assert.equal(row.headers.traceparent,`00-${traceId}-${parentId}-01`,'stored outbox carrier is immutable');
 }finally{
  clearTimeout(timer);if(publisher)await publisher.close();if(consumer)await consumer.close();await sdk.shutdown();
 }
});
