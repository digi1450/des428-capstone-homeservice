// Disposable E Task4/A acceptance. No shared .env, realm, volumes or Docker settings.
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,copyFileSync,existsSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {messagingFaults} from './faults.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const resume=process.env.FINAL_STACK_DIRECTORY;
const directory=resume?resolve(resume):mkdtempSync(join(tmpdir(),'homeservice-final-stack-'));
const project=process.env.FINAL_STACK_PROJECT||'homeservice-e-auth-final-'+process.pid;
assert.match(project,/^homeservice-e-auth-[a-z0-9-]+$/);
const marker=join(directory,'.acceptance-owned.json');
if(resume){assert.equal(JSON.parse(readFileSync(marker)).project,project,'owned disposable deployment required');}
else{
 for(const args of [['ps','-aq','--filter','label=com.docker.compose.project='+project],['volume','ls','-q','--filter','label=com.docker.compose.project='+project]])
  assert.equal(execFileSync('docker',args,{encoding:'utf8'}).trim(),'','project must be new; never adopt existing data');
 const paths=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
 for(const path of paths){const dest=join(directory,path);mkdirSync(dirname(dest),{recursive:true});copyFileSync(join(root,path),dest);}
 writeFileSync(marker,JSON.stringify({project}),{mode:0o600,flag:'wx'});
 execFileSync(process.execPath,['scripts/prepare-authenticated-compose.mjs'],{cwd:directory,stdio:'inherit'});
}
const args=['compose','--env-file','.env.authenticated','-p',project,'-f','docker-compose.yml','-f','docker-compose.resources.yml','-f','docker-compose.authenticated.yml','-f','docker-compose.authenticated-resources.yml'];
function docker(extra,input){const r=spawnSync('docker',[...args,...extra],{cwd:directory,input,encoding:'utf8',maxBuffer:16*1024**2});if(r.status!==0){writeFileSync(join(directory,'last-command-error.log'),r.stderr,{mode:0o600});throw Error('Compose command failed: '+extra.slice(0,2).join(' ')+' (inspect task-only logs in '+directory+')');}return r.stdout;}
function logged(extra,name){const r=spawnSync('docker',[...args,...extra],{cwd:directory,encoding:'utf8',maxBuffer:32*1024**2});writeFileSync(join(directory,name),r.stdout+'\n'+r.stderr,{mode:0o600});assert.equal(r.status,0,'Compose '+extra[0]+' failed; see '+name);}
const js=(service,code)=>docker(['exec','-T',service,'node','--input-type=module'],code).trim();
const crash=(service,name,code)=>{
 const env=Object.fromEntries(readFileSync(join(directory,'.env.authenticated'),'utf8').trim().split('\n').map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1)];}));
 const input='process.env.AMQP_URL='+JSON.stringify(env.AUTHENTICATED_AMQP_URL)+';\n'+code;
 const result=spawnSync('docker',[...args,'exec','-T','-e','OTEL_SERVICE_NAME='+name,service,'node','--import','./src/tracing.js','--input-type=module'],{cwd:directory,input,encoding:'utf8',timeout:90000});
 writeFileSync(join(directory,name+'-private.log'),(result.stdout??'')+'\n'+(result.stderr??''),{mode:0o600});
 assert.equal(result.status,137,'Expected SIGKILL at '+name+' checkpoint; inspect private diagnostic');
 const checkpoint=(result.stdout??'').split('\n').find(l=>l.startsWith('{"checkpoint":'));assert.ok(checkpoint,'crash checkpoint required');return JSON.parse(checkpoint);
};
const pass=name=>console.log('PASS '+name);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function ready(workers,expected=200){for(let n=0;n<60;n++){if(workers.every(name=>Number(js(name,"try{console.log((await fetch('http://127.0.0.1:3000/health/ready',{signal:AbortSignal.timeout(2000)})).status)}catch{console.log(0)}"))===expected))return;await sleep(1000);}throw Error('Worker readiness deadline '+expected);}
let active=false;
try{
 if(!resume){logged(['build'],'build.log');logged(['up','-d','--no-build','--wait','--wait-timeout','240'],'startup.log');}
 const initial=JSON.parse(docker(['config','--format','json']));assert.equal(Object.keys(initial.services).length,16);assert.equal(initial.services.edemand.environment.AUTHENTICATED_SERVICES_ENABLED,'false');
 execFileSync(process.execPath,['scripts/verify-authenticated-compose.mjs','--full-stack'],{cwd:directory,env:{...process.env,COMPOSE_PROJECT_NAME:project},stdio:'inherit'});
 const envPath=join(directory,'.env.authenticated');const env=Object.fromEntries(readFileSync(envPath,'utf8').trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
 for(const key of ['AUTHENTICATED_SERVICES_ENABLED','AUTHENTICATED_CUTOVER_APPROVED','OIDC_LOGIN_ENABLED','OIDC_SELF_REGISTRATION_ENABLED','AREA_B_AUTH_ENABLED'])env[key]='true';
 env.AUTHENTICATED_AMQP_URL='amqp://homeservice:'+env.RABBITMQ_PASSWORD+'@rabbitmq:5672?frameMax=131072';
 writeFileSync(envPath,Object.entries(env).map(([k,v])=>k+'='+v).join('\n')+'\n',{mode:0o600});
 // Only disposable env is activated; tracked defaults remain false.
 logged(['up','-d','--no-build','--no-deps','--wait','--wait-timeout','150','notifications','payments-wallet','edemand'],'activation.log');active=true;
 const configured=JSON.parse(docker(['config','--format','json']));for(const key of ['AUTHENTICATED_SERVICES_ENABLED','AUTHENTICATED_CUTOVER_APPROVED','OIDC_LOGIN_ENABLED','OIDC_SELF_REGISTRATION_ENABLED'])assert.equal(configured.services.edemand.environment[key],'true');
 const fixture=JSON.parse(js('edemand',`import Database from 'better-sqlite3';const db=new Database(process.env.DB_PATH,{readonly:true});console.log(JSON.stringify({customerId:db.prepare('SELECT id FROM customers ORDER BY id LIMIT 1').get().id,bobId:db.prepare('SELECT id FROM customers ORDER BY id LIMIT 1 OFFSET 1').get().id,providerId:db.prepare("SELECT id FROM providers WHERE email='sparkle@example.com'").get().id,addressId:db.prepare('SELECT id FROM addresses ORDER BY id LIMIT 1').get().id}));db.close();`));
 Object.assign(fixture,{password:randomBytes(24).toString('hex')+'Aa1!',adminSecret:env.KEYCLOAK_ADMIN_PASSWORD,bookingSecret:env.BOOKING_SERVICE_CLIENT_SECRET,gatewaySecret:env.KEYCLOAK_GATEWAY_CLIENT_SECRET});
 const driver=readFileSync(join(root,'tests/final-stack/driver.mjs'),'utf8');
 const drive=phase=>js('notifications','const fixture='+JSON.stringify(fixture)+';const phase='+JSON.stringify(phase)+';\n'+driver);
 const users=JSON.parse(drive('prepare'));
 for(const {name,sub}of users){const role=name==='provider'?'provider':'customer',id=name==='alice'?fixture.customerId:name==='bob'?fixture.bobId:fixture.providerId;
  js('edemand',`import {execFileSync} from 'node:child_process';execFileSync(process.execPath,['scripts/provision-keycloak-identity.js','https://id.homeservice.test:18443/realms/homeservice',${JSON.stringify(sub)},${JSON.stringify(role)},${JSON.stringify(String(id))}],{stdio:'pipe'});console.log('provisioned');`);
 }
 pass('deployed owner CLI provisions explicit existing identities without email linking');
 console.log(drive('auth'));console.log(drive('business'));
 if(process.env.FINAL_STACK_TELEMETRY==='true'){
  docker(['cp',join(directory,'infra/grafana/dashboards/homeservice-monitoring.json'),'notifications:/tmp/task5-dashboard.json']);
  const verifier=readFileSync(join(root,'tests/final-stack/telemetry.mjs'),'utf8');
  const result=js('notifications','const fixture='+JSON.stringify({grafanaSecret:env.GRAFANA_ADMIN_PASSWORD})+';\n'+verifier);console.log(result);
  const summaries=JSON.parse(result.trim().split('\n').at(-1)).telemetry;
  const flows=summaries.filter(x=>x.flow),records=[];
  for(const service of ['edemand','payments-wallet','payments-wallet-consumer','notifications-event-consumer']){
   const lines=docker(['logs','--no-log-prefix',service]).split('\n');
   for(const line of lines){let row;try{row=JSON.parse(line);}catch{continue;}
    if(flows.some(f=>f.traceId===row.traceId)&&['http_request','event_processed','event_duplicate_skipped'].includes(row.event)){
     assert.ok(!line.includes(fixture.password));
     for(const secret of [env.BOOKING_SERVICE_CLIENT_SECRET,env.KEYCLOAK_GATEWAY_CLIENT_SECRET,env.OIDC_SESSION_SECRET])assert.ok(!secret||!line.includes(secret));
     assert.ok(!row.path||!row.path.includes('?'));
     records.push({service,event:row.event,traceId:row.traceId,requestId:row.requestId??null,eventId:row.event_id??null});
    }
   }
  }
  for(const service of ['edemand','payments-wallet','payments-wallet-consumer','notifications-event-consumer'])assert.ok(records.some(r=>r.service===service),'correlated logs '+service);
  writeFileSync(join(directory,'task5-telemetry-summary.json'),JSON.stringify({tracesAndPanels:summaries,logs:records},null,2),{mode:0o600});
  pass('trace-correlated real HTTP/consumer JSON logs; no query, test password or service secret in correlated records');
 }
 const state=()=>JSON.parse(js('notifications',"import {readFileSync} from 'node:fs';console.log(readFileSync('/tmp/final-stack-acceptance.json','utf8'));"));
 if(process.env.FINAL_STACK_FAULTS==='true')await messagingFaults({docker,js,drive,crash,state,directory,pass});
 const holds=id=>Number(js('edemand',`import Database from 'better-sqlite3';const db=new Database(process.env.DB_PATH,{readonly:true});console.log(db.prepare('SELECT count(*) n FROM slot_holds WHERE order_id=?').get(${id}).n);db.close();`));
 const data=state(),held=holds(data.recoveryId);assert.ok(held>0);
 docker(['stop','payments-wallet']);console.log(drive('outage'));assert.equal(holds(data.recoveryId),held);
 if(process.env.FINAL_STACK_FAULTS==='true'){
  const traceId=state().recoveryTraceId;let observed=false;
  for(let n=0;n<40;n++){
   const found=js('notifications',`const t=(await(await fetch('http://jaeger:16686/api/traces/'+${JSON.stringify(traceId)})).json()).data?.[0];console.log(Boolean(t?.spans.some(s=>s.operationName==='booking financial delivery'&&s.tags.some(t=>t.key==='booking.work.state'&&t.value==='pending'))));`);
   if(found==='true'){observed=true;break;}await sleep(500);
  }
  assert.ok(observed,'failed delivery span must export before killing Next');
  docker(['kill','-s','SIGKILL','edemand']);docker(['start','edemand']);pass('actual standalone Next SIGKILL while cancellation work is pending');
 }
 else logged(['restart','edemand'],'restart-pending.log');
 // /api/ready may fail while downstream is intentionally down. Probe actual saved session instead.
 for(let n=0;;n++){try{console.log(drive('restart-pending'));break;}catch(error){if(n===30)throw error;await sleep(1000);}}
 assert.equal(holds(data.recoveryId),held);
 docker(['start','payments-wallet']);console.log(drive('recovered'));assert.equal(holds(data.recoveryId),0);
 if(process.env.FINAL_STACK_FAULTS==='true'){
  const verifier=readFileSync(join(root,'tests/final-stack/recovery-trace.mjs'),'utf8');
  const result=js('notifications',verifier);console.log(result);writeFileSync(join(directory,'task5-recovery-trace.json'),result.trim().split('\n').at(-1),{mode:0o600});
 }
 const counts=JSON.parse(js('payments-wallet',`import {createDatabase} from './src/database.js';const db=createDatabase(process.env.DATABASE_URL);console.log(JSON.stringify((await db.query('SELECT order_id,kind,count(*)::int n FROM transactions WHERE order_id=ANY($1::int[]) GROUP BY order_id,kind ORDER BY order_id,kind',[[${data.completedId},${data.refundId}]])).rows));await db.close();`));
 assert.deepEqual(counts,[{order_id:data.completedId,kind:'charge',n:1},{order_id:data.completedId,kind:'payout_credit',n:1},{order_id:data.refundId,kind:'charge',n:1},{order_id:data.refundId,kind:'refund',n:1}]);pass('owning PostgreSQL proves one charge/payout/refund despite HTTP replay');
 const workers=['notifications-event-consumer','payments-wallet-consumer','payments-outbox-relay'];await ready(workers);
 try{docker(['stop','rabbitmq']);await ready(workers,503);pass('actual broker outage makes all three independent workers unready');}finally{docker(['start','rabbitmq']);}
 await ready(workers);pass('all three workers reconnect after broker restart');
 const monitoring=js('payments-wallet',`import assert from 'node:assert/strict';for(const url of ['http://prometheus:9090/-/ready','http://grafana:3000/api/health','http://jaeger:16686/'])assert.equal((await fetch(url)).status,200);const targets=await(await fetch('http://prometheus:9090/api/v1/targets')).json();assert.ok(targets.data.activeTargets.some(x=>x.labels.job==='notifications'&&x.health==='up'));assert.ok(targets.data.activeTargets.some(x=>x.labels.job==='payments-wallet'&&x.health==='up'));const traces=await(await fetch('http://jaeger:16686/api/traces?service=notifications-event-consumer&limit=20')).json();assert.ok(traces.data.length>0);console.log('PASS actual Prometheus scrape targets and actual consumer spans exported to Jaeger (not complete root/monolith tracing)');`);console.log(monitoring);
 const stats=execFileSync('docker',['stats','--no-stream','--format','{{json .}}',...docker(['ps','-q']).trim().split('\n')],{encoding:'utf8'});writeFileSync(join(directory,'observed-stats.jsonl'),stats,{mode:0o600});
 // Preserve every project volume and container writable layer for restart verification.
 docker(['stop']);logged(['up','-d','--no-build','--wait','--wait-timeout','240'],'restart-all.log');console.log(drive('persisted'));
 const rows=docker(['ps','--format','json']).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));assert.equal(rows.length,16);for(const row of rows){assert.equal(row.State,'running',row.Service);if(row.Health)assert.equal(row.Health,'healthy',row.Service);}
 pass('all 16 actual services running; every configured readiness probe healthy in authenticated mode');
 console.log(JSON.stringify({status:'passed',project,services:16,limitsGiB:6.25,scope:process.env.FINAL_STACK_TELEMETRY==='true'?'E Task4 deployment plus Task5 selected full-flow telemetry':'E Task4 actual authenticated fresh deployment',remaining:['historical account/data eligibility and cutover','broader fault/load and 8GB peak acceptance',...(process.env.FINAL_STACK_TELEMETRY==='true'?[]:['full-flow telemetry acceptance']),'graphical browser and offline clean-clone acceptance']}));
}finally{
 // Ownership marker checked before all destructive cleanup; shared projects never selected.
 assert.equal(JSON.parse(readFileSync(marker)).project,project);
 if(process.env.FINAL_STACK_KEEP!=='true')logged(['down','--volumes','--remove-orphans'],'cleanup.log');
 console.log('Task-only evidence directory: '+directory+(active?' (disposable auth enabled during test only)':''));
}
