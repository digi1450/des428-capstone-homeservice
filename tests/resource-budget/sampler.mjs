// Separate host process: remains active while the acceptance runner blocks in Docker exec.
import {spawn,execFileSync} from 'node:child_process';import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';import {join} from 'node:path';import {createInterface} from 'node:readline';
const [project,directory]=process.argv.slice(2);
if(!/^homeservice-e-auth-[a-z0-9-]+$/.test(project)||JSON.parse(readFileSync(join(directory,'.acceptance-owned.json'))).project!==project)throw Error('Owned project required');
const helperName=project+'-resource-probe',probeBytes=64*1024**2,reserveBytes=1024**3,budgetBytes=8_000_000_000;
const command=args=>execFileSync('docker',args,{encoding:'utf8',maxBuffer:4*1024**2,windowsHide:true}).trim();
const helper=spawn('docker',['run','--rm','-i','--name',helperName,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory',String(probeBytes),'--memory-swap',String(probeBytes),'--cgroupns','host','--mount','type=bind,src=/sys/fs/cgroup,dst=/host-cgroup,readonly','--mount','type=bind,src='+join(directory,'tests/resource-budget/cgroups.mjs')+',dst=/sample.mjs,readonly','node:22-slim','node','--max-old-space-size=24','/sample.mjs'],{stdio:['pipe','pipe','ignore'],windowsHide:true});
let response;
createInterface({input:helper.stdout}).on('line',line=>{const pending=response;response=null;if(pending){clearTimeout(pending.timer);try{pending.resolve(JSON.parse(line));}catch{pending.reject(Error('Invalid cgroup sample'));}}});
const probe=ids=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{response=null;reject(Error('Read-only cgroup probe deadline'));},15000);response={resolve,reject,timer};helper.stdin.write(JSON.stringify(ids)+'\n');});
const services={},phases={},issues=new Set();let count=0,peakAggregate=0,first,last,stopped=false;
const host=JSON.parse(command(['info','--format','{"memoryBytes":{{.MemTotal}},"cpus":{{.NCPU}},"cgroupDriver":{{json .CgroupDriver}},"cgroupVersion":{{json .CgroupVersion}}}']));
if(host.cgroupVersion!=='2')throw Error('Task6 needs cgroup v2 memory.peak, no silent fallback');
const format='{"id":{{json .Id}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"running":{{json .State.Running}},"oom":{{json .State.OOMKilled}},"restart":{{.RestartCount}},"limit":{{.HostConfig.Memory}},"memorySwap":{{.HostConfig.MemorySwap}}}';
async function sample(){
 const ids=command(['ps','-aq','--filter','label=com.docker.compose.project='+project]).split('\n').filter(Boolean);
 if(!ids.length)return;
 const meta=command(['inspect','--format',format,...ids]).split('\n').filter(Boolean).map(l=>JSON.parse(l));
 const result=await probe(meta.filter(x=>x.running).map(x=>x.id));if(result.error)throw Error(result.error);
 let phase='startup';try{phase=JSON.parse(readFileSync(join(directory,'task6-phase.json'))).phase;}catch{}
 const now=Date.now();first??=now;last=now;count++;let total=0;const rows=[];
 for(const m of meta){
  const s=services[m.service]??={peakBytes:0,swapBytes:0,oom:0,oomKills:0,restarts:0,samples:0,limitBytes:m.limit};
  if(!m.limit||m.memorySwap!==m.limit)issues.add('Missing hard RAM/no-swap limit: '+m.service);
  if(s.limitBytes!==m.limit)issues.add('Limit changed during run: '+m.service);
  if(m.oom)issues.add('Docker OOM: '+m.service);s.restarts=Math.max(s.restarts,m.restart);
  if(m.restart)issues.add('Automatic restart: '+m.service);
  const r=result.rows.find(x=>x.id===m.id);if(!r||r.missing){if(m.running)rows.push({service:m.service,unavailable:true});continue;}
  s.samples++;s.peakBytes=Math.max(s.peakBytes,r.peak);s.swapBytes=Math.max(s.swapBytes,r.swap);s.oom=Math.max(s.oom,r.oom);s.oomKills=Math.max(s.oomKills,r.oomKill);total+=r.current;
  if(r.swap||r.oom||r.oomKill)issues.add('Swap/OOM event: '+m.service);
  rows.push({service:m.service,currentBytes:r.current,kernelPeakBytes:r.peak,swapBytes:r.swap});
 }
 peakAggregate=Math.max(peakAggregate,total);const p=phases[phase]??={samples:0,peakCurrentBytes:0};p.samples++;p.peakCurrentBytes=Math.max(p.peakCurrentBytes,total);
 appendFileSync(join(directory,'task6-memory-samples.jsonl'),JSON.stringify({elapsedMs:now-first,phase,totalCurrentBytes:total,rows})+'\n',{mode:0o600});
}
const queue=[];let pumping=false,timer;
async function pump(){if(pumping)return;pumping=true;clearTimeout(timer);
 try{
  while(queue.length){const request=queue.shift();
   try{
    await sample();
    if(request.type==='stop'){
     stopped=true;helper.stdin.end();await new Promise(resolve=>helper.once('exit',resolve));
     const list=Object.entries(services);if(list.length!==16||list.some(([,s])=>s.samples===0))issues.add('All16 services must have real kernel samples');
     for(const phase of ['startup','load-warm','load-steady','load-peak','load-mixed-financial','load-cooldown','recovery','whole-stack-restart'])if(!phases[phase]?.samples)issues.add('Missing phase samples: '+phase);
     const sumKernelPeaks=list.reduce((n,[,s])=>n+s.peakBytes,0),configuredLimits=list.reduce((n,[,s])=>n+s.limitBytes,0);
     if(configuredLimits+probeBytes+reserveBytes>budgetBytes||sumKernelPeaks+probeBytes+reserveBytes>budgetBytes)issues.add('8GB runtime budget plus explicit reserve exceeded');
     const summary={budgetBytes,host,probeAllowanceBytes:probeBytes,hostReserveAllowanceBytes:reserveBytes,configuredLimitsBytes:configuredLimits,sampledAggregatePeakBytes:peakAggregate,sumServiceKernelPeaksBytes:sumKernelPeaks,conservativeTotalWithAllowancesBytes:sumKernelPeaks+probeBytes+reserveBytes,sampleCount:count,observedMs:(last??0)-(first??0),services,phases,issues:[...issues],scope:'16-container runtime incl. load child, plus64MiB observer allowance and1GiB explicit host reserve; host/build/whole8GB-machine performance not measured'};
     writeFileSync(join(directory,'task6-memory-summary.json'),JSON.stringify(summary,null,2),{mode:0o600});process.send({id:request.id,summary});
    }else if(request.id)process.send({id:request.id});
   }catch(error){issues.add('Sampler failure');if(request.id)process.send({id:request.id,error:'Resource sampling failed; inspect task-only environment'});}
  }
 }finally{pumping=false;if(!stopped)timer=setTimeout(()=>{queue.push({type:'periodic'});pump();},2000);}
}
process.on('message',request=>{queue.push(request);pump();});
process.on('disconnect',()=>{helper.stdin.end();process.exit(0);});
