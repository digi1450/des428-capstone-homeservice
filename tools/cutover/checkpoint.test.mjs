import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {mkdtempSync,copyFileSync,writeFileSync,readFileSync,rmSync,existsSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {loadApprovedSnapshot} from '../data-migration/approved-snapshot.mjs';
import {importApprovedSnapshot} from '../data-migration/import-snapshot.mjs';
import {importBookingBindings} from '../data-migration/booking-bindings.mjs';
import {createDatabase as payments} from '../../services/payments-wallet/src/database.js';
import {createDatabase as notifications} from '../../services/notifications/src/database.js';
import {migrate as migrateP} from '../../services/payments-wallet/src/migrations.js';
import {migrate as migrateN} from '../../services/notifications/src/migrations.js';
import {createPaymentsRuntime} from '../../services/payments-wallet/src/runtime.js';
import {createFinancialOperations} from '../../services/payments-wallet/src/financial/index.js';
import {approveCheckpoint,revokeCheckpoint,inspectCheckpoint} from './checkpoint.mjs';
import {createCutoverOperatorVerifier} from './operator.mjs';
import {readCheckpoint,deploymentLegacyApproval} from '../../services/payments-wallet/src/legacy-checkpoint.js';
const require=createRequire(new URL('../../bangkok-homeservice/package.json',import.meta.url));
const Database=require('better-sqlite3');
const amqp=createRequire(new URL('../../services/payments-wallet/package.json',import.meta.url))('amqplib');
const fixture=process.env.CUTOVER_FIXTURE_DIR;
const issuer='https://operator.fixture/realms/homeservice';
const pair=generateKeyPairSync('rsa',{modulusLength:2048}),jwk={...pair.publicKey.export({format:'jwk'}),kid:'operator-fixture',alg:'RS256'};
const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
function jwt(changes={}){const body={iss:issuer,aud:'homeservice-cutover',azp:'homeservice-cutover-operator',sub:'operator-fixture',exp:Math.floor(Date.now()/1000)+60,resource_access:{'homeservice-cutover':{roles:['cutover:approve_checkpoint','cutover:revoke_checkpoint']}},...changes};const input=encode({alg:'RS256',kid:'operator-fixture'})+'.'+encode(body);return input+'.'+sign('RSA-SHA256',Buffer.from(input),pair.privateKey).toString('base64url');}
const verifyOperator=createCutoverOperatorVerifier({issuer,fetchImpl:async()=>({ok:true,json:async()=>({keys:[jwk]})})});
const wait=async work=>{for(let i=0;i<50;i++){try{return await work();}catch(e){if(i===49)throw e;await new Promise(r=>setTimeout(r,300));}}};
test('actual three-owner and broker checkpoint, partial apply, tampering, revoke and post-write refusal',async t=>{
 assert.ok(fixture&&process.env.CUTOVER_PAYMENTS_URL&&process.env.CUTOVER_NOTIFICATIONS_URL&&process.env.CUTOVER_AMQP_URL);
 const directory=join(fixture,'snapshot'),envelope=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'));
 const approved=await loadApprovedSnapshot(directory,envelope.manifest_sha256);
 const root=mkdtempSync(join(tmpdir(),'cutover-rehearsal-')),file=join(root,'booking.sqlite'),keyFile=join(root,'receipt.key'),publicKeyFile=join(root,'receipt.pub'),receiptFile=join(root,'checkpoint.json');
 copyFileSync(join(directory,'source.sqlite'),file);const signing=generateKeyPairSync('ed25519');writeFileSync(keyFile,signing.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});writeFileSync(publicKeyFile,signing.publicKey.export({type:'spki',format:'pem'}),{mode:0o644});
 const db=new Database(file);db.pragma('foreign_keys=ON');
 const p=payments(process.env.CUTOVER_PAYMENTS_URL),n=notifications(process.env.CUTOVER_NOTIFICATIONS_URL);
 const connection=await amqp.connect(process.env.CUTOVER_AMQP_URL),channel=await connection.createChannel();
 for(const q of ['booking.events','ratings.events','notifications.events','payments.events']){await channel.assertQueue(q,{durable:true});await channel.assertQueue(q+'.dlq',{durable:true});}
 const broker={amqpUrl:process.env.CUTOVER_AMQP_URL,managementUrl:process.env.CUTOVER_BROKER_MANAGEMENT_URL};
 const freeze={ingress_closed:true,writers_stopped:true,recovery_stopped:true,consumers_disconnected:true,restore_rehearsed:true,backup_set_id:randomUUID(),deployment_config_sha256:'a'.repeat(64)};
 const options={approved,bookingDb:db,paymentsDatabase:p,notificationsDatabase:n,broker,freeze,backupDirectory:join(fixture,'backups'),keyFile,publicKeyFile,receiptFile,token:jwt(),verifyOperator};
 try{
  await migrateP(p);await migrateN(n);importBookingBindings(db,approved,{apply:true});
  await importApprovedSnapshot(p,'payments-wallet',approved,{apply:true});
  await t.test('partial owner apply and invalid operator never publish approval',async()=>{
   await assert.rejects(approveCheckpoint({...options,token:jwt({azp:'booking-service'})}));
   await assert.rejects(approveCheckpoint(options));assert.equal(existsSync(receiptFile),false);
   assert.equal(db.prepare('SELECT state FROM booking_legacy_payment_checkpoints').get().state,'bound');
  });
  await importApprovedSnapshot(n,'notifications',approved,{apply:true});
  await t.test('correct sources reconcile; active consumers or unacknowledged delivery block checkpoint',async()=>{
   await wait(()=>inspectCheckpoint(options));
   channel.sendToQueue('booking.events',Buffer.from('owned-fixture'));
   const message=await wait(async()=>{const x=await channel.get('booking.events');assert.ok(x);return x;});
   const url=new URL(process.env.CUTOVER_AMQP_URL),authorization='Basic '+Buffer.from(decodeURIComponent(url.username)+':'+decodeURIComponent(url.password)).toString('base64');
   await wait(async()=>{const response=await fetch(new URL('/api/queues/%2F/booking.events',broker.managementUrl),{headers:{Authorization:authorization}});const data=await response.json();assert.equal(data.messages_unacknowledged,1);});
   await assert.rejects(approveCheckpoint(options));channel.ack(message);
   await wait(()=>inspectCheckpoint(options));
  });
  await t.test('freeze attestation and changed retained/owner context fail closed',async()=>{
   await assert.rejects(approveCheckpoint({...options,freeze:{...freeze,writers_stopped:false}}));
   await n.query("UPDATE notifications SET body=body||' changed' WHERE id=70");
   await assert.rejects(approveCheckpoint(options));
   await n.query('UPDATE notifications SET body=$1 WHERE id=70',[JSON.parse(readFileSync(join(directory,'notifications.json'),'utf8')).tables.notifications.find(x=>x.id===70).body]);
   db.prepare('UPDATE orders SET total_cents=total_cents+1 WHERE id=13').run();await assert.rejects(approveCheckpoint(options));db.prepare('UPDATE orders SET total_cents=total_cents-1 WHERE id=13').run();
  });
  await t.test('commit-before-publication interruption stays closed and reconciliation can finish',async()=>{
   await assert.rejects(approveCheckpoint({...options,receiptFile:join(root,'missing-directory','receipt.json')}));
   assert.equal(db.prepare('SELECT state FROM booking_legacy_payment_checkpoints').get().state,'approved');
   assert.equal(existsSync(receiptFile),false);
   assert.throws(()=>deploymentLegacyApproval({LEGACY_CHECKPOINT_FILE:receiptFile,LEGACY_CHECKPOINT_PUBLIC_KEY_FILE:publicKeyFile}));
  });
  await t.test('sealed approval is idempotent across process reads; checker requires every source',async()=>{
   const result=await approveCheckpoint(options);assert.equal(result.state,'approved');assert.equal(result.replayed,false);
   assert.equal((await approveCheckpoint(options)).replayed,true);
   const config={LEGACY_CHECKPOINT_FILE:receiptFile,LEGACY_CHECKPOINT_PUBLIC_KEY_FILE:publicKeyFile};assert.equal(deploymentLegacyApproval(config),envelope.manifest_sha256);
   const child=await promisify(execFile)(process.execPath,['--input-type=module','-e',`import {deploymentLegacyApproval} from ${JSON.stringify(new URL('../../services/payments-wallet/src/legacy-checkpoint.js',import.meta.url).href)};console.log(deploymentLegacyApproval());`],{env:{...process.env,...config}});assert.equal(child.stdout.trim(),envelope.manifest_sha256);
   const args=['--sqlite',file,'--payments-url',process.env.CUTOVER_PAYMENTS_URL,'--notifications-url',process.env.CUTOVER_NOTIFICATIONS_URL,'--amqp-url',broker.amqpUrl,'--broker-management-url',broker.managementUrl,'--mode','quiescent','--legacy-directory',directory,'--manifest-sha256',envelope.manifest_sha256,'--checkpoint-file',receiptFile,'--checkpoint-public-key-file',publicKeyFile,'--json'];
   const checker=await promisify(execFile)(process.execPath,[new URL('../consistency/c-check.mjs',import.meta.url).pathname,...args]);assert.equal(JSON.parse(checker.stdout).ok,true);
   const saved=readFileSync(receiptFile);const changed=JSON.parse(saved);changed.payload.manifest_sha256='f'.repeat(64);writeFileSync(receiptFile,JSON.stringify(changed)+'\n');assert.throws(()=>readCheckpoint(receiptFile,publicKeyFile));writeFileSync(receiptFile,saved);
   chmodSync(receiptFile,0o666);assert.throws(()=>readCheckpoint(receiptFile,publicKeyFile));chmodSync(receiptFile,0o600);
  });
  await t.test('pre-write revoke closes gate; new money/work forbids reverting to stale SQLite',async()=>{
   assert.equal((await revokeCheckpoint(options)).state,'revoked');assert.equal(existsSync(receiptFile),false);assert.equal(db.prepare('SELECT state FROM booking_legacy_payment_checkpoints').get().state,'bound');
   await approveCheckpoint(options);
   const runtime=createPaymentsRuntime({database:p,createFinancialOperations,legacyManifestSha256:readCheckpoint(receiptFile,publicKeyFile).manifest_sha256});
   await runtime.business.settleWebhook({gateway_event_id:randomUUID(),type:'payment_intent.succeeded',gateway_ref:'SIM-13'});
   await assert.rejects(revokeCheckpoint(options));assert.equal(existsSync(receiptFile),true);
   // Rollback fixture is restored into a NEW file, never over the changed Booking.
   const restored=join(root,'restored.sqlite');copyFileSync(join(fixture,'backups/source.sqlite'),restored);const old=new Database(restored);assert.equal(old.prepare('SELECT payment_status FROM orders WHERE id=13').get().payment_status,'pending');old.close();
  });
 }finally{await channel.close();await connection.close();db.close();await p.close();await n.close();rmSync(root,{recursive:true,force:true});}
});
