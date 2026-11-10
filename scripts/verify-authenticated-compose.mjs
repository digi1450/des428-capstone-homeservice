// Machine-auth/TLS/config checks; --faults stops/restarts this disposable broker.
// No browser user/account/data cutover is inferred from this smoke test.
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const project=process.env.COMPOSE_PROJECT_NAME||'homeservice-e-auth-review';
if(!/^homeservice-e-auth-[a-z0-9-]+$/.test(project))throw Error('Use an explicitly disposable homeservice-e-auth-* project');
const args=['compose','--env-file','.env.authenticated','-p',project,'-f','docker-compose.yml','-f','docker-compose.resources.yml','-f','docker-compose.authenticated.yml','-f','docker-compose.authenticated-resources.yml'];
function docker(extra,input){const r=spawnSync('docker',[...args,...extra],{encoding:'utf8',input,maxBuffer:8*1024*1024});if(r.status!==0)throw Error('Compose verification failed: '+(r.stderr||'Docker unavailable'));return r.stdout;}
const config=JSON.parse(docker(['config','--format','json']));
assert.equal(Object.keys(config.services).length,16);
let memory=0;for(const [name,service]of Object.entries(config.services)){assert.ok(service.mem_limit>0,name+' memory limit missing');memory+=Number(service.mem_limit);}
assert.ok(memory<8*1024**3);
assert.equal(config.services.edemand.environment.AUTHENTICATED_SERVICES_ENABLED,'false');
assert.equal(config.services.edemand.environment.AUTHENTICATED_CUTOVER_APPROVED,'false');
console.log('PASS: 16 services have memory limits, total '+(memory/1024**3).toFixed(3)+' GiB; default cutover gates stay off');
if(process.argv.includes('--config-only'))process.exit(0);
const env=Object.fromEntries(readFileSync('.env.authenticated','utf8').split(/\r?\n/).filter(l=>l&&!l.startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1)];}));
let smoke=readFileSync('infra/keycloak/smoke-real-service-tokens.mjs','utf8').replace(/^#![^\n]*\n/,'').replace('../../services/payments-wallet/src/security/booking-verifier.js','./src/security/booking-verifier.js');
smoke='process.env.KEYCLOAK_ISSUER="https://id.homeservice.test:18443/realms/homeservice";\n'+
 'process.env.KEYCLOAK_BOOKING_CLIENT_SECRET='+JSON.stringify(env.BOOKING_SERVICE_CLIENT_SECRET)+';\n'+
 'process.env.KEYCLOAK_GATEWAY_CLIENT_SECRET='+JSON.stringify(env.KEYCLOAK_GATEWAY_CLIENT_SECRET)+';\n'+smoke;
// Secrets travel on stdin, not command arguments or logged environment output.
console.log(docker(['exec','-T','payments-wallet','node','--input-type=module'],smoke).trim());
const tls=`import assert from 'node:assert/strict';
const publicPayments=await fetch('https://payments.homeservice.test:18444/internal/payment-commands/missing');
assert.equal(publicPayments.status,404);
const resolver=await fetch('https://identity.homeservice.test:18445/not-allowed');assert.equal(resolver.status,404);
const response=await fetch('https://notifications.homeservice.test:18444/health/ready');assert.equal(response.status,200);
console.log('PASS: trusted in-container TLS/DNS, Notifications readiness and private-route filtering');`;
console.log(docker(['exec','-T','payments-wallet','node','--input-type=module'],tls).trim());
if(process.argv.includes('--full-stack')){
 const smoke=`import assert from 'node:assert/strict';
 for(const url of ['https://app.homeservice.test:18444/api/ready','http://prometheus:9090/-/ready','http://grafana:3000/api/health','http://jaeger:16686/'])assert.equal((await fetch(url)).status,200,url);
 console.log('PASS: full-stack Next via trusted TLS, Prometheus, Grafana and Jaeger HTTP readiness');`;
 console.log(docker(['exec','-T','payments-wallet','node','--input-type=module'],smoke).trim());
}
if(process.argv.includes('--faults')){
 const workers=['notifications-event-consumer','payments-wallet-consumer','payments-outbox-relay'];
 const status=worker=>Number(docker(['exec','-T',worker,'node','-e',"fetch('http://127.0.0.1:3000/health/ready').then(r=>console.log(r.status)).catch(()=>console.log(0))"]).trim());
 const eventually=async(expected)=>{for(let i=0;i<45;i++){if(workers.every(w=>status(w)===expected))return;await new Promise(r=>setTimeout(r,2000));}throw Error('Workers did not reach readiness '+expected);};
 await eventually(200);
 try{docker(['stop','rabbitmq']);await eventually(503);console.log('PASS: actual broker stop makes all three workers not ready');}
 finally{docker(['start','rabbitmq']);}
 await eventually(200);console.log('PASS: all three workers reconnect and become ready after actual broker restart');
}
