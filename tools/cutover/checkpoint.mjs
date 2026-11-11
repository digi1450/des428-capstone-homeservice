// Offline coordination only. No application reads across owning databases.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
import {readFileSync,readdirSync,writeFileSync,existsSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {approvedPayload} from '../data-migration/approved-snapshot.mjs';
import {columns,validateSnapshot} from '../data-migration/import-snapshot.mjs';
import {canonical,privateFile,trustedFile,sealCheckpoint,verifyCheckpoint,readCheckpoint} from '../../services/payments-wallet/src/legacy-checkpoint.js';
import {checkBroker} from '../consistency/broker-check.mjs';
const need=(v,code='CHECKPOINT_RECONCILIATION_REQUIRED')=>{if(!v)throw Error(code);};
export const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const PG_WORK=['outbox_events','payment_commands','payment_provisioning','processed_events','financial_commands','financial_fences'];
function expectedMigrations(service){
 const dir=new URL('../../services/'+service+'/migrations/',import.meta.url);
 return readdirSync(dir).filter(x=>/^\d+_[a-z0-9_]+\.sql$/.test(x)).sort().map(version=>({version,sha256:sha(readFileSync(new URL(version,dir)))}));
}
export async function ownerState(client,service,bundle,expectedBindings){
 await client.query('SET TRANSACTION READ ONLY');
 need(same((await client.query('SELECT version,sha256 FROM schema_migrations ORDER BY version')).rows,expectedMigrations(service)));
 const expected=validateSnapshot(service,bundle),state={};
 for(const [table,rows] of Object.entries(expected)){
  const key=table==='provider_wallets'?'provider_id':'id';
  const actual=(await client.query(`SELECT ${columns[table].join(',')} FROM ${table} ORDER BY ${key}`)).rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v instanceof Date?v.toISOString():v])));
  need(same(actual,rows));state[table]=actual;
 }
 const work=service==='payments-wallet'?PG_WORK:['processed_events'];
 for(const table of work)need((await client.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n===0,'CHECKPOINT_NEW_WORK_PRESENT');
 if(service==='payments-wallet'){
  const keys=['order_id','binding_id','manifest_sha256','intent_id','customer_id','provider_id','amount_cents','currency','eligibility'];
  const bindings=(await client.query(`SELECT ${keys.join(',')} FROM legacy_payment_bindings ORDER BY order_id`)).rows;
  need(same(bindings,expectedBindings));state.bindings=bindings;
 }
 return state;
}
export function bookingState(db,payload){
 const {manifest:core,manifest_sha256:hash}=payload.envelope;
 for(const [table,expected] of Object.entries(payload.source_rows)){
  need(/^[a-z_]+$/.test(table));need(same(db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all(),expected),'CHECKPOINT_BOOKING_CHANGED');
 }
 for(const table of ['booking_sagas','booking_saga_activations','booking_saga_transitions','booking_financial_work','processed_events','consistency_attention'])need(db.prepare(`SELECT count(*) n FROM ${table}`).get().n===0,'CHECKPOINT_NEW_WORK_PRESENT');
 const expected=core.bindings.map(x=>({order_id:x.order_id,binding_id:`legacy:${hash}:${x.order_id}`,manifest_sha256:hash}));
 const actual=db.prepare('SELECT * FROM booking_legacy_payment_bindings ORDER BY order_id').all();need(same(actual,expected));
 const checkpoints=db.prepare('SELECT * FROM booking_legacy_payment_checkpoints').all();
 need(checkpoints.length===1);const cp=checkpoints[0];need(cp.manifest_sha256===hash&&cp.snapshot_id===core.snapshot_id&&cp.bindings_json===JSON.stringify(core.bindings)&&['bound','approved'].includes(cp.state));
 return {bindings:actual,snapshot_id:core.snapshot_id};
}
export async function brokerState(broker){
 need(broker?.amqpUrl&&broker?.managementUrl,'CHECKPOINT_BROKER_REQUIRED');
 const report={info:{},findings:[],add(severity,id,rows){const count=Array.isArray(rows)?rows.length:rows;if(count)this.findings.push({severity,id,count});}};
 await checkBroker(broker.amqpUrl,report,{managementUrl:broker.managementUrl,mode:'quiescent'});
 need(report.findings.length===0&&report.info.broker_unacknowledged_verified,'CHECKPOINT_BROKER_NOT_QUIESCENT');
 return report.info.queues;
}
function freezeProof(value,payload,backups){
 const fields=['ingress_closed','writers_stopped','recovery_stopped','consumers_disconnected','restore_rehearsed','backup_set_id','deployment_config_sha256'];
 need(value&&Object.keys(value).sort().join(',')===[...fields].sort().join(','),'CHECKPOINT_FREEZE_REQUIRED');
 for(const k of fields.slice(0,5))need(value[k]===true,'CHECKPOINT_FREEZE_REQUIRED');
 need(/^[0-9a-f-]{36}$/.test(value.backup_set_id)&&/^[0-9a-f]{64}$/.test(value.deployment_config_sha256));
 const source=privateFile(join(backups,'source.sqlite'));
 need(sha(source)===payload.envelope.manifest.source.sqlite_backup_sha256,'CHECKPOINT_BACKUP_MISMATCH');
 const result={source:sha(source)};
 for(const owner of ['payments','notifications']){const bytes=privateFile(join(backups,owner+'-before.dump'));need(bytes.subarray(0,5).toString()==='PGDMP','CHECKPOINT_BACKUP_REQUIRED');result[owner]=sha(bytes);}
 return {...value,backups:result};
}
export async function inspectCheckpoint({approved,bookingDb,paymentsDatabase,notificationsDatabase,broker}){
 const payload=approvedPayload(approved),hash=payload.envelope.manifest_sha256;
 const expected=payload.envelope.manifest.bindings.map(e=>({order_id:e.order_id,binding_id:`legacy:${hash}:${e.order_id}`,manifest_sha256:hash,...Object.fromEntries(['intent_id','customer_id','provider_id','amount_cents','currency','eligibility'].map(k=>[k,e[k]]))}));
 const booking=bookingState(bookingDb,payload);
 const payments=await paymentsDatabase.withTransaction(tx=>ownerState(tx,'payments-wallet',payload.bundles['payments-wallet'],expected));
 const notifications=await notificationsDatabase.withTransaction(tx=>ownerState(tx,'notifications',payload.bundles.notifications));
 const queues=await brokerState(broker);
 return {payload,phase_digest:digest({booking,payments,notifications,queues}),manifest_sha256:hash,snapshot_id:payload.envelope.manifest.snapshot_id};
}
// Freeze attestation is external operator responsibility, not inferred from a flag.
// The gate rechecks all owner rows/work/queues; it cannot discover unknown writers.
export async function approveCheckpoint(options){
 const {token,verifyOperator,freeze,backupDirectory,keyFile,publicKeyFile,receiptFile,bookingDb}=options;
 const who=await verifyOperator(token,'approve_checkpoint');need(who?.service==='cutover');
 const state=await inspectCheckpoint(options),proof=freezeProof(freeze,state.payload,backupDirectory);
 if(existsSync(receiptFile)){
  const prior=readCheckpoint(receiptFile,publicKeyFile);need(prior.manifest_sha256===state.manifest_sha256&&prior.snapshot_id===state.snapshot_id&&prior.phase_digest===state.phase_digest&&prior.freeze_digest===digest(proof));
  need(bookingDb.prepare('SELECT state FROM booking_legacy_payment_checkpoints WHERE manifest_sha256=?').get(state.manifest_sha256)?.state==='approved');
  return {state:'approved',manifest_sha256:state.manifest_sha256,snapshot_id:state.snapshot_id,replayed:true};
 }
 const payload={version:1,state:'approved',manifest_sha256:state.manifest_sha256,snapshot_id:state.snapshot_id,phase_digest:state.phase_digest,backup_set_id:proof.backup_set_id,operator_id:who.callerId,approved_at:new Date().toISOString(),freeze_digest:digest(proof)};
 const sealed=sealCheckpoint(payload,privateFile(keyFile));
 verifyCheckpoint(sealed,trustedFile(publicKeyFile));
 // Commit local approval first. Missing receipt after a crash keeps BOTH signed
 // runtime gates closed; identical reconciliation can safely publish it on retry.
 bookingDb.exec('BEGIN IMMEDIATE');
 try{
  bookingState(bookingDb,state.payload);
  bookingDb.prepare("UPDATE booking_legacy_payment_checkpoints SET state='approved' WHERE manifest_sha256=?").run(state.manifest_sha256);
  bookingDb.exec('COMMIT');
 }catch(error){bookingDb.exec('ROLLBACK');throw error;}
 writeFileSync(receiptFile,canonical(sealed)+'\n',{mode:0o600,flag:'wx'});
 return {state:'approved',manifest_sha256:state.manifest_sha256,snapshot_id:state.snapshot_id,replayed:false};
}
export async function revokeCheckpoint(options){
 const who=await options.verifyOperator(options.token,'revoke_checkpoint');need(who?.service==='cutover');
 const prior=readCheckpoint(options.receiptFile,options.publicKeyFile);
 const state=await inspectCheckpoint(options);
 const proof=freezeProof(options.freeze,state.payload,options.backupDirectory);need(prior.freeze_digest===digest(proof));
 need(prior.manifest_sha256===state.manifest_sha256&&prior.phase_digest===state.phase_digest,'CHECKPOINT_POST_WRITE_ROLLBACK_FORBIDDEN');
 options.bookingDb.transaction(()=>options.bookingDb.prepare("UPDATE booking_legacy_payment_checkpoints SET state='bound' WHERE manifest_sha256=?").run(state.manifest_sha256)).immediate();
 unlinkSync(options.receiptFile);
 return {state:'revoked',manifest_sha256:state.manifest_sha256};
}
