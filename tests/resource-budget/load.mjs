import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const percentile=(values,q)=>values.slice().sort((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*q)-1)];
// Closed-loop fixed-concurrency workload, not an open-arrival capacity claim.
export async function runLoad({api,browse,base,alice,pro,state,fixture,gateway,jar,until}){
 const summary={model:'closed-loop,100ms think time,5s request deadline',stages:[],orders:[]};
 async function refresh(){
  for(const cookies of [alice,pro])assert.equal((await api(cookies,'/api/auth/keycloak/refresh',{}, {Origin:base})).status,200);
 }
 const endpoints=[['inbox',alice,'/api/notifications'],['wallet',pro,'/api/provider/wallet'],['history',alice,'/api/customer/transactions'],['booking',alice,'/api/bookings/'+state.completedId],['identity',alice,'/api/me'],['wallet-page',pro,'/provider/wallet']];
 async function readers(name,users,seconds){
  await refresh();console.log(JSON.stringify({task6Phase:name}));
  const times=[],errors=[],byEndpoint={},start=performance.now(),deadline=start+seconds*1000;
  await Promise.all(Array.from({length:users},async(_,user)=>{
   let iteration=0;
   while(performance.now()<deadline){
    const [label,cookies,path]=endpoints[(user+iteration++)%endpoints.length],t=performance.now();let ok=false,status=0;
    try{const r=await browse(cookies,base+path,{headers:{'X-Request-Id':'task6-'+name+'-'+user+'-'+iteration},signal:AbortSignal.timeout(5000)});status=r.status;await r.arrayBuffer();ok=status===200;}catch{}
    times.push(performance.now()-t);const c=byEndpoint[label]??={requests:0,failures:0};c.requests++;if(!ok){c.failures++;if(errors.length<10)errors.push({endpoint:label,status});}
    await sleep(100);
   }
  }));
  const elapsedMs=performance.now()-start,failures=Object.values(byEndpoint).reduce((n,x)=>n+x.failures,0);
  const row={name,users,durationTargetSeconds:seconds,elapsedMs,requests:times.length,failures,rps:times.length/(elapsedMs/1000),p50Ms:percentile(times,.5),p95Ms:percentile(times,.95),p99Ms:percentile(times,.99),byEndpoint,errors};summary.stages.push(row);
  console.log(JSON.stringify({task6Stage:row}));
  assert.ok(row.requests>=users*10,'executed requests required');assert.equal(failures,0,name+' unexpected HTTP failures');assert.ok(row.p95Ms<3000,name+' p95 must stay below3s');
  console.log('PASS Task6 '+name+': '+row.requests+' requests,0 failures,p95 '+Math.round(row.p95Ms)+'ms');
 }
 await readers('warm',5,20);await readers('steady',15,60);await readers('peak',30,60);
 await refresh();console.log(JSON.stringify({task6Phase:'mixed-financial'}));
 const flowTimes=[],start=performance.now();let next=0;
 await Promise.all(Array.from({length:2},async()=>{
  while(next<20){
   const index=next++,began=performance.now(),day=new Date(Date.now()+(45+index*2)*86400000);while(day.getUTCDay()===0)day.setUTCDate(day.getUTCDate()+1);
   const created=await api(alice,'/api/bookings',{provider_id:fixture.providerId,address_id:fixture.addressId,service_date:day.toISOString().slice(0,10),starting_time:'10:00',items:[{service_id:2,quantity:1}],payment_method:'gateway'},{'Idempotency-Key':'task6-'+randomUUID()});assert.equal(created.status,201);
   const id=created.body.order.id;await until(async()=>((await api(alice,'/api/bookings/'+id)).body.payment_setup==='ready'),'load activation');
   assert.equal((await api(jar(),'/api/payments/webhook',{gateway_event_id:'task6-'+randomUUID(),gateway_ref:created.body.payment_intent.gateway_ref,type:'payment_intent.succeeded'},{Authorization:'Bearer '+await gateway()})).status,200);
   await until(async()=>((await api(alice,'/api/bookings/'+id)).body.payment_status==='paid'),'load paid delivery');
   if(index%2===0){
    for(const action of ['confirm','start'])assert.equal((await api(pro,'/api/bookings/'+id+'/'+action,{})).status,200);
    const r=await api(pro,'/api/bookings/'+id+'/complete',{otp:created.body.otp});assert.equal(r.status,200);assert.equal(r.body.accounting_status,'ready');
    summary.orders.push({id,kind:'completion'});
   }else{assert.equal((await api(alice,'/api/bookings/'+id+'/cancel',{})).status,200);summary.orders.push({id,kind:'cancellation'});}
   flowTimes.push(performance.now()-began);
  }
 }));
 const financial={name:'mixed-financial',users:2,flows:flowTimes.length,completed:summary.orders.filter(x=>x.kind==='completion').length,refunded:summary.orders.filter(x=>x.kind==='cancellation').length,elapsedMs:performance.now()-start,p95Ms:percentile(flowTimes,.95)};
 assert.equal(financial.flows,20);assert.equal(financial.completed,10);assert.equal(financial.refunded,10);assert.ok(financial.p95Ms<15000,'financial p95 must stay below15s');summary.financial=financial;
 console.log('PASS Task6 real financial load:10 completions and10 paid refunds at concurrency2');
 await readers('cooldown',5,20);await refresh();
 // A fresh post-load trace verifies bounded trace retention did not disable export.
 const traceId=randomUUID().replaceAll('-','');const probe=await browse(alice,base+'/api/notifications',{headers:{traceparent:'00-'+traceId+'-1234567890abcdef-01'}});assert.equal(probe.status,200);await probe.arrayBuffer();
 await until(async()=>{const t=(await(await fetch('http://jaeger:16686/api/traces/'+traceId)).json()).data?.[0];return Boolean(t?.spans.some(s=>t.processes[s.processID].serviceName==='notifications'));},'post-load trace export');
 summary.postLoadTraceId=traceId;console.log('PASS Task6 post-load trace export remains active');
 return summary;
}
