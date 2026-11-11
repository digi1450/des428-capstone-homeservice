// OFFLINE ONLY. Recognize one exact instructor-era schema; runtime migration
// continues to reject it. No seed/reset or synthetic historical event identity.
import {createRequire} from 'node:module';
import {isDeepStrictEqual as same} from 'node:util';
import {migrate} from '../../bangkok-homeservice/lib/db/migrate.js';
import {approvedPayload} from './approved-snapshot.mjs';
const Database=createRequire(new URL('../../bangkok-homeservice/package.json',import.meta.url))('better-sqlite3');
export const ORIGINAL_EVENTS_SQL=`CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at TEXT
)`;
const ADDED=new Set(['idx_booking_financial_work_due','idx_booking_saga_activations_due','idx_booking_sagas_due','idx_events_unpublished','booking_financial_work','booking_legacy_payment_bindings','booking_legacy_payment_checkpoints','booking_saga_activations','booking_saga_transitions','booking_sagas','booking_work_trace_context','consistency_attention','event_trace_context','processed_events','legacy_event_archive','app_schema_version']);
export const schemaObjects=db=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY type,name").all();
const reference=new Database(':memory:');
let current;
try{migrate(reference);current=schemaObjects(reference);}finally{reference.close();}
export const ORIGINAL_SCHEMA=Object.freeze(current.filter(x=>!ADDED.has(x.name)).map(x=>x.name==='events'?{...x,sql:ORIGINAL_EVENTS_SQL}:x));
const need=(value,code='ORIGINAL_SCHEMA_REVIEW_REQUIRED')=>{if(!value)throw Error(code);};
export const isOriginalSource=payload=>same(payload.source_schema,ORIGINAL_SCHEMA);
function rows(db,table){need(/^[a-z_]+$/.test(table));return db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();}
export function assertRetainedSource(db,payload,{archiveOriginal=isOriginalSource(payload)}={}){
 for(const [table,expected] of Object.entries(payload.source_rows)){
  need(same(rows(db,archiveOriginal&&table==='events'?'legacy_event_archive':table),expected),'BOOKING_BINDING_RECONCILIATION_REQUIRED');
 }
 if(archiveOriginal)need(rows(db,'events').length===0,'ORIGINAL_EVENT_REPLAY_FORBIDDEN');
}
function emptyNewWork(db){
 for(const x of current.filter(x=>x.type==='table'&&(ADDED.has(x.name)||x.name==='events'))){
  if(['app_schema_version','legacy_event_archive'].includes(x.name))continue;
  need(rows(db,x.name).length===0,'ORIGINAL_UPGRADE_NEW_WORK_PRESENT');
 }
}
class DryRun extends Error{constructor(report){super('DRY_RUN');this.report=report;}}
export function prepareOriginalBooking(db,approved,{apply=false}={}){
 const payload=approvedPayload(approved);need(isOriginalSource(payload));
 const sourceEvents=payload.source_rows.events;
 need(Array.isArray(sourceEvents)&&sourceEvents.every(x=>Number.isSafeInteger(x.id)&&x.id>0&&typeof x.processed_at==='string'&&x.processed_at),'ORIGINAL_EVENTS_NOT_DRAINED');
 try{return db.transaction(()=>{
  const actual=schemaObjects(db),replayed=same(actual,current);
  if(replayed){assertRetainedSource(db,payload);emptyNewWork(db);}
  else{
   need(same(actual,ORIGINAL_SCHEMA));assertRetainedSource(db,payload,{archiveOriginal:false});
   const sequences=db.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get()?db.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name').all():[];
   db.exec(current.find(x=>x.name==='legacy_event_archive').sql);
   db.exec('INSERT INTO legacy_event_archive SELECT * FROM events');
   // All original event bytes remain in the archive. Nothing is stamped
   // published or assigned a fabricated UUID/command. No old effect is replayed.
   db.exec('DROP TABLE events');
   const present=new Set(schemaObjects(db).map(x=>x.name));
   for(const x of current.filter(x=>x.name!=='app_schema_version'&&!present.has(x.name)).sort((a,b)=>(a.type==='table'?0:1)-(b.type==='table'?0:1)))db.exec(x.sql);
   migrate(db); // exact current-schema adoption only; no initializer/backfill/seed
   need(same(schemaObjects(db),current));assertRetainedSource(db,payload);emptyNewWork(db);
   const after=db.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get()?db.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name').all():[];
   need(same(sequences,after),'ORIGINAL_SEQUENCE_CHANGED');
  }
  need(db.pragma('foreign_key_check').length===0&&db.pragma('quick_check',{simple:true})==='ok','ORIGINAL_TARGET_INTEGRITY_REQUIRED');
  const report={state:'prepared',action:replayed?'identical-replay':'upgrade',mode:apply?'apply':'dry-run',manifest_sha256:payload.envelope.manifest_sha256,snapshot_id:payload.envelope.manifest.snapshot_id,legacy_event_count:sourceEvents.length,legacy_event_watermark:sourceEvents.reduce((max,x)=>Math.max(max,x.id),0)};
  if(!apply)throw new DryRun(report);return report;
 }).immediate();}catch(error){if(error instanceof DryRun)return error.report;throw error;}
}
