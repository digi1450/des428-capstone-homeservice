import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NodeSDK} from '@opentelemetry/sdk-node';
import {SpanKind,trace,ROOT_CONTEXT} from '@opentelemetry/api';
import {traced,currentCarrier,safeCarrier,traceMetadata,requestSpan} from '../lib/telemetry/context.js';
import {freshBoot} from '../test-helpers/boot.js';
import {getDb} from '../lib/db/index.js';
import {insertEvent} from '../lib/db/events.js';
import {relayOnce} from '../lib/messaging/broker-relay.js';
const spans=[],sdk=new NodeSDK({autoDetectResources:false,instrumentations:[],metricReaders:[],logRecordProcessors:[],spanProcessors:[{onStart(){},onEnd(s){spans.push(s);},forceFlush:async()=>{},shutdown:async()=>{}}]});
sdk.start();
const traceId='1234567890abcdef1234567890abcdef',parentId='1234567890abcdef';
const carrier={traceparent:`00-${traceId}-${parentId}-01`,'x-request-id':'test-request',tracestate:'vendor=test'};
test('durable trace context commits atomically, survives relay/retry and never enters public data',async t=>{
 t.after(()=>sdk.shutdown());freshBoot();const db=getDb();let eventId;
 await requestSpan(new Request('https://app.example.test/api/bookings/123?token=private',{headers:carrier}),'test-request',async()=>{
  eventId=insertEvent('provider.registered','provider',1,{provider_id:1});
  assert.equal(traceMetadata().traceparent.split('-')[1],traceId);
 });
 const saved=db.prepare('SELECT * FROM event_trace_context WHERE event_id=?').get(eventId);
 assert.equal(JSON.parse(saved.headers_json).traceparent.split('-')[2],spans.at(-1).spanContext().spanId);
 assert.equal(spans.at(-1).name,'GET /api/bookings/:id');
 assert.ok(!JSON.stringify(spans.at(-1).attributes).includes('private'));
 const original=db.prepare('SELECT event_uuid,payload_json FROM events WHERE id=?').get(eventId),attempts=[];
 const publisher={publish:async(envelope,headers)=>{
  attempts.push({envelope,headers});if(attempts.length===1)throw Error('outage');
 }};
 assert.equal((await relayOnce({publisher,owner:'test'})).failed,1);
 db.prepare("UPDATE events SET next_publish_at='2000-01-01'").run();
 assert.equal((await relayOnce({publisher,owner:'test'})).published,1);
 assert.deepEqual(attempts[0],attempts[1]);assert.equal(attempts[1].envelope.event_id,original.event_uuid);
 assert.deepEqual(attempts[1].envelope.data,{provider_id:1});
 assert.equal(db.prepare('SELECT headers_json FROM event_trace_context WHERE event_id=?').get(eventId).headers_json,saved.headers_json);
 const before=db.prepare('SELECT count(*) n FROM events').get().n;
 await traced('rollback',{carrier},async()=>{
  assert.throws(()=>db.transaction(()=>{insertEvent('provider.registered','provider',2,{provider_id:2});assert.equal(db.prepare('SELECT count(*) n FROM event_trace_context').get().n,2);throw Error('rollback');})());
 });
 assert.equal(db.prepare('SELECT count(*) n FROM events').get().n,before);
 assert.equal(db.prepare('SELECT count(*) n FROM event_trace_context').get().n,1);
 await trace.getTracer('test').startActiveSpan('ambient',{},ROOT_CONTEXT,async span=>{
  const ambient=span.spanContext().traceId;
  await traced('rabbitmq process',{kind:SpanKind.CONSUMER,carrier:{traceparent:'invalid',Authorization:'secret',baggage:'private'}},async()=>assert.notEqual(currentCarrier().traceparent.split('-')[1],ambient));span.end();
 });
 assert.deepEqual(safeCarrier({traceparent:'00-'+ '0'.repeat(32)+'-'+parentId+'-01','x-request-id':'a\nb',Authorization:'secret'}),{});
 assert.deepEqual(safeCarrier({...carrier,Authorization:'secret',baggage:'private',password:'private'}),carrier);
});
