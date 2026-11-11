// Offline owner tool only; never imported by application routes.
import {isDeepStrictEqual as same} from 'node:util';
import {approvedPayload} from './approved-snapshot.mjs';
import {assertRetainedSource} from './original-booking-schema.mjs';
import {migrate} from '../../bangkok-homeservice/lib/db/migrate.js';
const need=(v)=>{if(!v)throw new Error('BOOKING_BINDING_RECONCILIATION_REQUIRED');};
class DryRun extends Error{constructor(report){super('DRY_RUN');this.report=report;}}
export function importBookingBindings(db,approved,{apply=false}={}){
 const {envelope,source_rows:source}=approvedPayload(approved);
 const core=envelope.manifest,hash=envelope.manifest_sha256;
 const rows=core.bindings.map(x=>({order_id:x.order_id,binding_id:`legacy:${hash}:${x.order_id}`,manifest_sha256:hash}));
 try{return db.transaction(()=>{
  need(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='orders'").get());
  migrate(db); // nested savepoint; entire upgrade rolls back with failed import/dry-run
  need(source&&typeof source==='object');
  assertRetainedSource(db,approvedPayload(approved));
  for(const table of ['booking_sagas','booking_financial_work','booking_saga_activations','processed_events','consistency_attention'])need(db.prepare(`SELECT count(*) n FROM ${table}`).get().n===0);
  const current=db.prepare('SELECT * FROM booking_legacy_payment_bindings ORDER BY order_id').all();
  const checkpoints=db.prepare('SELECT * FROM booking_legacy_payment_checkpoints').all();
  const checkpoint={manifest_sha256:hash,snapshot_id:core.snapshot_id,bindings_json:JSON.stringify(core.bindings),state:'bound'};
  const fresh=current.length===0&&checkpoints.length===0;
  if(!fresh){need(same(current,rows));need(same(checkpoints,[checkpoint]));}
  else{
   const insert=db.prepare('INSERT INTO booking_legacy_payment_bindings(order_id,binding_id,manifest_sha256) VALUES(@order_id,@binding_id,@manifest_sha256)');
   for(const row of rows)insert.run(row);
   db.prepare('INSERT INTO booking_legacy_payment_checkpoints(manifest_sha256,snapshot_id,bindings_json,state) VALUES(@manifest_sha256,@snapshot_id,@bindings_json,@state)').run(checkpoint);
  }
  need(same(db.prepare('SELECT * FROM booking_legacy_payment_bindings ORDER BY order_id').all(),rows));
  const report={snapshot_id:core.snapshot_id,manifest_sha256:hash,bindings:rows.length,state:'bound',action:fresh?'import':'identical-replay',mode:apply?'apply':'dry-run'};
  if(!apply)throw new DryRun(report);return report;
 }).immediate();}catch(error){if(error instanceof DryRun)return error.report;throw error;}
}
