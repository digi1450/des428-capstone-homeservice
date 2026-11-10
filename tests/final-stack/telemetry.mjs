// Invoked in the existing Notifications container, after actual business flows.
// Only a sanitized graph summary leaves the disposable environment.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const state=JSON.parse(readFileSync('/tmp/final-stack-acceptance.json','utf8'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(let n=0;n<90;n++){try{return await fn();}catch{}await sleep(1000);}throw Error('Telemetry deadline: '+label);}
const service=(t,s)=>t.processes[s.processID].serviceName;
const nodes=(t,name,op)=>t.spans.filter(s=>service(t,s)===name&&s.operationName===op);
const tag=(s,key)=>s.tags?.find(t=>t.key===key)?.value;
function child(t,parents,children){return children.some(c=>c.references?.some(r=>r.refType==='CHILD_OF'&&r.traceID===t.traceID&&parents.some(p=>p.spanID===r.spanID)));}
const summary=[];
for(const [label,id,check] of [
 ['provider-wallet',state.providerTraceId,t=>{
  const root=nodes(t,'edemand','POST /api/auth/keycloak/profile'),publish=nodes(t,'edemand','rabbitmq publish'),consume=nodes(t,'payments-wallet-consumer','rabbitmq process');
  assert.ok(root.length&&child(t,root,publish)&&child(t,publish,consume));
  assert.ok(consume.some(s=>tag(s,'messaging.destination.name')==='payments.events'));
 }],
 ['webhook-paid-booking',state.traceId,t=>{
  const root=nodes(t,'edemand','POST /api/payments/webhook'),http=t.spans.filter(s=>service(t,s)==='payments-wallet'&&s.kind!=='client'&&s.references?.some(r=>root.some(p=>p.spanID===r.spanID))),publish=nodes(t,'payments-outbox-relay','rabbitmq publish'),consume=nodes(t,'edemand','rabbitmq process');
  assert.ok(root.length&&http.length&&publish.length&&child(t,publish,consume));
  assert.ok(publish.some(s=>tag(s,'messaging.rabbitmq.destination.routing_key')==='payment.succeeded'));
  assert.ok(consume.some(s=>tag(s,'messaging.destination.name')==='booking.events'));
  // The relay's parent is the originating service context stored with the PG outbox.
  assert.ok(publish.some(s=>s.references.some(r=>t.spans.some(p=>p.spanID===r.spanID&&service(t,p)==='payments-wallet'))));
 }],
 ['completion-notification',state.completeTraceId,t=>{
  const root=nodes(t,'edemand','POST /api/bookings/:id/complete'),publish=nodes(t,'edemand','rabbitmq publish'),consume=nodes(t,'notifications-event-consumer','rabbitmq process');
  assert.ok(root.length&&child(t,root,publish)&&child(t,publish,consume));
  assert.ok(publish.some(s=>['booking.status_changed','booking.completed'].includes(tag(s,'messaging.rabbitmq.destination.routing_key'))));
  assert.ok(t.spans.some(s=>service(t,s)==='payments-wallet'));
 }],
]){
 assert.match(id,/^[a-f0-9]{32}$/);
 const t=await until(async()=>{const r=await fetch('http://jaeger:16686/api/traces/'+id);assert.equal(r.status,200);const t=(await r.json()).data?.[0];assert.ok(t);check(t);return t;},label);
 summary.push({flow:label,traceId:id,spanCount:t.spans.length,services:[...new Set(t.spans.map(s=>service(t,s)))].sort(),edgesVerified:true});
}
console.log('PASS live Jaeger parent-child continuity: provider -> wallet; webhook -> owning PG outbox/relay -> Booking; completion -> Notifications');
const dashboard=JSON.parse(readFileSync('/tmp/task5-dashboard.json','utf8'));
const auth='Basic '+Buffer.from('admin:'+fixture.grafanaSecret).toString('base64');
const response=await fetch('http://grafana:3000/api/dashboards/uid/'+dashboard.uid,{headers:{Authorization:auth}});
assert.equal(response.status,200);const deployed=(await response.json()).dashboard;
assert.equal(deployed.title,dashboard.title);
for(const expected of dashboard.panels){
 const actual=deployed.panels.find(p=>p.title===expected.title);assert.ok(actual);
 for(const target of expected.targets){
  assert.ok(actual.targets.some(t=>t.expr===target.expr));
  const data=await until(async()=>{
   const r=await fetch('http://prometheus:9090/api/v1/query?query='+encodeURIComponent(target.expr));assert.equal(r.status,200);const b=await r.json();assert.equal(b.status,'success');
   for(const job of ['notifications','payments-wallet'])assert.ok(b.data.result.some(x=>x.metric.job===job&&Number.isFinite(Number(x.value[1]))));return b.data.result;
  },expected.title);
  summary.push({panel:expected.title,jobs:data.map(x=>x.metric.job).sort(),finiteValues:true});
 }
}
console.log('PASS provisioned Grafana dashboard and actual Prometheus request-rate / 5xx-rate / P95 data for both services');
console.log(JSON.stringify({telemetry:summary}));
