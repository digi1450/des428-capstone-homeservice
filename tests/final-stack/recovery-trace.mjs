// After real Payments outage + Next SIGKILL + autonomous recovery, before Jaeger restart.
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const state=JSON.parse(readFileSync('/tmp/final-stack-acceptance.json','utf8'));
let result;
for(let n=0;n<100;n++){
 try{
  const t=(await(await fetch('http://jaeger:16686/api/traces/'+state.recoveryTraceId)).json()).data?.[0];assert.ok(t);
  const owner=s=>t.processes[s.processID].serviceName,tag=(s,k)=>s.tags.find(x=>x.key===k)?.value;
  const attempts=t.spans.filter(s=>owner(s)==='edemand'&&s.operationName==='booking financial delivery');
  const failed=attempts.find(s=>tag(s,'booking.work.state')==='pending'&&tag(s,'otel.status_code')==='ERROR');
  const ready=attempts.find(s=>tag(s,'booking.work.state')==='ready');assert.ok(failed&&ready);assert.notEqual(failed.spanID,ready.spanID);
  assert.equal(tag(failed,'booking.command.id'),tag(ready,'booking.command.id'));assert.equal(tag(failed,'booking.operation.id'),tag(ready,'booking.operation.id'));assert.equal(failed.references[0].spanID,ready.references[0].spanID);
  const producer=t.spans.filter(s=>owner(s)==='edemand'&&s.operationName==='rabbitmq publish'&&s.references.some(r=>r.spanID===ready.spanID));assert.ok(producer.length);
  assert.ok(t.spans.some(s=>owner(s)==='notifications-event-consumer'&&s.operationName==='rabbitmq process'&&s.references.some(r=>producer.some(p=>p.spanID===r.spanID))));
  result={traceId:t.traceID,operationId:tag(ready,'booking.operation.id'),commandId:tag(ready,'booking.command.id'),failedSpan:failed.spanID,recoveredSpan:ready.spanID,originalParent:ready.references[0].spanID,attempts:attempts.length,notificationLinked:true};break;
 }catch{await new Promise(r=>setTimeout(r,500));}
}
assert.ok(result,'recovery trace must connect failed and successful attempts across actual process death');
console.log('PASS durable cancellation trace spans failed attempt -> actual Next SIGKILL -> autonomous retry -> Notifications with stable operation/key/parent');console.log(JSON.stringify(result));
