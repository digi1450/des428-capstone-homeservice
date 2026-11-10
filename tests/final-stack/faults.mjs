// Test orchestration only: crashes child workers using unchanged real producer/consumer libraries.
// No production fault switches, queue deletion, business-state rewrite or synthetic event injection.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(let i=0;i<90;i++){try{return await fn();}catch{}await delay(500);}throw Error('Fault deadline: '+label);}
export async function messagingFaults({docker,js,drive,crash,state,directory,pass}){
 const summary={};
 docker(['stop','payments-outbox-relay','notifications-event-consumer']);
 try{
  console.log(drive('fault-event'));const s=state();summary.traceId=s.faultTraceId;
  const query=()=>JSON.parse(js('payments-wallet',`import {createDatabase} from './src/database.js';const db=createDatabase(process.env.DATABASE_URL);const rows=(await db.query("SELECT event_id,headers,attempts,published_at,locked_by FROM outbox_events WHERE event_type='payment.succeeded' AND envelope->'data'->>'order_id'=$1",[${JSON.stringify(String(s.faultOrderId))}])).rows;console.log(JSON.stringify(rows));await db.close();`));
  const initial=query();assert.equal(initial.length,1);const event=initial[0];summary.eventId=event.event_id;
  assert.equal(event.published_at,null);assert.equal(event.attempts,0);assert.equal(event.headers.traceparent.split('-')[1],s.faultTraceId);
  const first=crash('payments-wallet','payments-fault-relay',`
import assert from 'node:assert/strict';
import {createDatabase} from './src/database.js';import {relayOnce} from './src/messaging/outbox.js';import {createPublisher} from './src/messaging/publisher.js';
const db=createDatabase(process.env.DATABASE_URL),publisher=await createPublisher(process.env.AMQP_URL);
await relayOnce({database:db,owner:'task5-crash-relay',batchSize:1,leaseMs:1000,publisher:{publish:async row=>{
 assert.equal(row.event_id,${JSON.stringify(event.event_id)});await publisher.publish(row);
 // Export and observe the ENDED actual producer span before SIGKILL, not a fixed sleep.
 let observed=false;for(let n=0;n<100;n++){const data=(await(await fetch('http://jaeger:16686/api/traces/'+${JSON.stringify(s.faultTraceId)})).json()).data;
 if(data?.[0]?.spans.some(x=>data[0].processes[x.processID].serviceName==='payments-fault-relay'&&x.operationName==='rabbitmq publish')){observed=true;break;}await new Promise(r=>setTimeout(r,100));}
 assert.ok(observed);console.log(JSON.stringify({checkpoint:'confirmed-before-mark',eventId:row.event_id}));process.kill(process.pid,'SIGKILL');
}}});throw Error('Crash was not reached');`);
  assert.equal(first.checkpoint,'confirmed-before-mark');
  const lost=query()[0];assert.equal(lost.published_at,null);assert.equal(lost.attempts,1);assert.equal(lost.locked_by,'task5-crash-relay');assert.deepEqual(lost.headers,event.headers);
  console.log(drive('fault-paid'));pass('SIGKILL after real broker confirm leaves the original PG outbox event unpublished and leased');
  const counts=()=>JSON.parse(js('notifications',`import {createDatabase} from './src/database.js';const db=createDatabase(process.env.DATABASE_URL);console.log(JSON.stringify({dedupe:(await db.query('SELECT effect_count FROM processed_events WHERE event_id=$1',[${JSON.stringify(event.event_id)}])).rows,notes:(await db.query("SELECT count(*)::int n FROM notifications WHERE order_id=$1 AND type='payment_received'",[${s.faultOrderId}])).rows[0].n}));await db.close();`));
  assert.deepEqual(counts(),{dedupe:[],notes:0});
  const rollback=crash('notifications','notifications-fault-before-commit',`
import {context,trace} from '@opentelemetry/api';import {createDatabase} from './src/database.js';import {createInbox} from './src/messaging/inbox.js';import {createNotificationEventWriter} from './src/event-writer.js';import {startConsumer} from './src/messaging/consumer.js';
const db=createDatabase(process.env.DATABASE_URL),writer=createNotificationEventWriter(db);setTimeout(()=>process.exit(2),20000);
const inbox=createInbox(db,{writer:{recordEvent:async(type,data,options)=>{
 const rows=await writer.recordEvent(type,data,options);
 if(type==='payment.succeeded'&&data.order_id===${s.faultOrderId}){console.log(JSON.stringify({checkpoint:'effect-before-commit',traceId:trace.getSpan(context.active()).spanContext().traceId}));process.kill(process.pid,'SIGKILL');}
 return rows;
}}});await startConsumer({amqpUrl:process.env.AMQP_URL,prefetch:1,inbox});`);
  assert.equal(rollback.checkpoint,'effect-before-commit');assert.equal(rollback.traceId,s.faultTraceId);
  assert.deepEqual(counts(),{dedupe:[],notes:0});pass('SIGKILL before Notifications transaction commit rolls back BOTH dedupe and effect; message stays deliverable');
  const second=crash('notifications','notifications-fault-consumer',`
import assert from 'node:assert/strict';import {context,trace} from '@opentelemetry/api';
import {createDatabase} from './src/database.js';import {createInbox} from './src/messaging/inbox.js';import {startConsumer} from './src/messaging/consumer.js';
const db=createDatabase(process.env.DATABASE_URL),inbox=createInbox(db);const timeout=setTimeout(()=>process.exit(2),20000);
await startConsumer({amqpUrl:process.env.AMQP_URL,prefetch:1,inbox:{handle:async envelope=>{
 const result=await inbox.handle(envelope);
 if(envelope.event_id===${JSON.stringify(event.event_id)}){assert.equal(result.duplicate,false);assert.equal(result.effects,1);
 console.log(JSON.stringify({checkpoint:'committed-before-ack',eventId:envelope.event_id,traceId:trace.getSpan(context.active()).spanContext().traceId}));process.kill(process.pid,'SIGKILL');}
 return result;
}}});`);
  assert.equal(second.checkpoint,'committed-before-ack');assert.equal(second.traceId,s.faultTraceId);
  assert.deepEqual(counts(),{dedupe:[{effect_count:1}],notes:1});pass('SIGKILL after real Notifications dedupe/effect commit occurs before RabbitMQ acknowledgement');
  docker(['start','notifications-event-consumer']);
  await until(()=>{const logs=docker(['logs','--no-log-prefix','notifications-event-consumer']);assert.ok(logs.split('\n').some(l=>{try{const x=JSON.parse(l);return x.event==='event_duplicate_skipped'&&x.event_id===event.event_id&&x.traceId===s.faultTraceId;}catch{return false;}}));return true;},'unacknowledged message redelivery');
  assert.deepEqual(counts(),{dedupe:[{effect_count:1}],notes:1});pass('actual worker restart redelivers the unacked event with the same trace and exactly one notification');
  docker(['start','payments-outbox-relay']);
  await until(()=>{const row=query()[0];assert.ok(row.published_at);assert.equal(row.attempts,2);assert.deepEqual(row.headers,event.headers);return row;},'original outbox lease recovery');
  // Poll exporter batching separately; require both producers and successful duplicate processing.
  summary.graph=await until(()=>JSON.parse(js('notifications',`
import assert from 'node:assert/strict';const t=(await(await fetch('http://jaeger:16686/api/traces/'+${JSON.stringify(s.faultTraceId)})).json()).data?.[0];assert.ok(t);
const owner=s=>t.processes[s.processID].serviceName;const tag=(s,k)=>s.tags.find(t=>t.key===k)?.value;
const producers=t.spans.filter(s=>s.operationName==='rabbitmq publish'&&tag(s,'messaging.message.id')===${JSON.stringify(event.event_id)});
const a=producers.find(s=>owner(s)==='payments-fault-relay'),b=producers.find(s=>owner(s)==='payments-outbox-relay');assert.ok(a&&b);assert.notEqual(a.spanID,b.spanID);assert.equal(a.references[0].spanID,b.references[0].spanID);
const processed=t.spans.filter(s=>owner(s)==='notifications-event-consumer'&&s.operationName==='rabbitmq process'&&tag(s,'messaging.message.id')===${JSON.stringify(event.event_id)});
assert.ok(processed.some(s=>s.references.some(r=>r.spanID===a.spanID)));assert.ok(processed.some(s=>s.references.some(r=>r.spanID===b.spanID)));
console.log(JSON.stringify({firstPublish:a.spanID,retryPublish:b.spanID,parent:a.references[0].spanID,consumerSpans:processed.length}));`)),'retry/redelivery trace graph');
  assert.deepEqual(counts(),{dedupe:[{effect_count:1}],notes:1});
  const money=JSON.parse(js('payments-wallet',`import {createDatabase} from './src/database.js';const db=createDatabase(process.env.DATABASE_URL);console.log(JSON.stringify((await db.query("SELECT kind,count(*)::int n FROM transactions WHERE order_id=$1 GROUP BY kind",[${s.faultOrderId}])).rows));await db.close();`));
  assert.deepEqual(money,[{kind:'charge',n:1}]);
  const bookingDedupe=Number(js('edemand',`import Database from 'better-sqlite3';const db=new Database(process.env.DB_PATH,{readonly:true});console.log(db.prepare("SELECT count(*) n FROM processed_events WHERE event_id=? AND consumer_name='booking.payments'").get(${JSON.stringify(event.event_id)}).n);db.close();`));assert.equal(bookingDedupe,1);
  await until(()=>{const value=js('payments-wallet-consumer',`import assert from 'node:assert/strict';const u=new URL(process.env.AMQP_URL);const r=await fetch('http://rabbitmq:15672/api/queues',{headers:{Authorization:'Basic '+Buffer.from(decodeURIComponent(u.username)+':'+decodeURIComponent(u.password)).toString('base64')}});assert.equal(r.status,200);const rows=await r.json();for(const name of ['booking.events','notifications.events']){const q=rows.find(x=>x.name===name);assert.ok(q);assert.equal(q.messages_ready,0);assert.equal(q.messages_unacknowledged,0);}console.log('drained');`);assert.equal(value,'drained');return true;},'both owning queues drained');
  summary.final={outboxAttempts:2,notificationEffects:1,charges:1,bookingDedupe,queuesDrained:true,beforeCommitRollback:true,consumerCrashCheckpoint:second.checkpoint};
  pass('lease recovery republishes the SAME event/parent with a fresh producer span; owning PG proves one charge and one notification');
  writeFileSync(join(directory,'task5-fault-summary.json'),JSON.stringify(summary,null,2),{mode:0o600});
 }finally{docker(['start','notifications-event-consumer','payments-outbox-relay']);}
}
