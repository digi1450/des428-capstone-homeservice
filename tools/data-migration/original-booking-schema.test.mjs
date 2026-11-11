import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtempSync,readFileSync,copyFileSync,rmSync,cpSync,linkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadApprovedSnapshot,approvedPayload} from './approved-snapshot.mjs';
import {prepareOriginalBooking,ORIGINAL_SCHEMA,schemaObjects} from './original-booking-schema.mjs';
import {importBookingBindings} from './booking-bindings.mjs';
import {getDb,closeDb} from '../../bangkok-homeservice/lib/db/index.js';
import {insertEvent,listUnprocessed} from '../../bangkok-homeservice/lib/db/events.js';
import {migrate} from '../../bangkok-homeservice/lib/db/migrate.js';
const snapshot=db=>({schema:schemaObjects(db),tables:Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()])),sequences:db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all()});
const Database=createRequire(new URL('../../bangkok-homeservice/package.json',import.meta.url))('better-sqlite3');
test('exact original Booking upgrade preserves audit/rows/counters, never replays history, and rolls back failures',async t=>{
 const directory=join(process.env.CUTOVER_FIXTURE_DIR,'original-snapshot');
 const envelope=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'));
 const approved=await loadApprovedSnapshot(directory,envelope.manifest_sha256),payload=approvedPayload(approved);
 const root=mkdtempSync(join(tmpdir(),'original-booking-test-')),file=join(root,'edemand.db');
 const fresh=()=>{copyFileSync(join(directory,'source.sqlite'),file);const db=new Database(file);db.pragma('foreign_keys=ON');return db;};
 try{
  await t.test('normal runtime rejects original; unknown source/target schema and changed rows remain rejected',async()=>{
   const unknownDirectory=join(process.env.CUTOVER_FIXTURE_DIR,'unknown-original-snapshot'),unknownEnvelope=JSON.parse(readFileSync(join(unknownDirectory,'manifest.json'),'utf8'));
   const unknown=await loadApprovedSnapshot(unknownDirectory,unknownEnvelope.manifest_sha256);
   let rejected=fresh();const beforeUnknown=snapshot(rejected);assert.throws(()=>prepareOriginalBooking(rejected,unknown,{apply:true}),/ORIGINAL_SCHEMA_REVIEW_REQUIRED/);assert.deepEqual(snapshot(rejected),beforeUnknown);rejected.close();
   let db=fresh();assert.equal(ORIGINAL_SCHEMA.length,36);assert.deepEqual(schemaObjects(db),ORIGINAL_SCHEMA);assert.throws(()=>migrate(db),/SQLITE_SCHEMA_MISMATCH/);db.close();
   db=fresh();db.exec('CREATE TABLE unexpected(id INTEGER)');const before=snapshot(db);assert.throws(()=>prepareOriginalBooking(db,approved,{apply:true}),/ORIGINAL_SCHEMA_REVIEW_REQUIRED/);assert.deepEqual(snapshot(db),before);db.close();
   db=fresh();db.prepare('UPDATE orders SET total_cents=total_cents+1 WHERE id=13').run();const changed=snapshot(db);assert.throws(()=>prepareOriginalBooking(db,approved,{apply:true}),/RECONCILIATION/);assert.deepEqual(snapshot(db),changed);db.close();
  });
  await t.test('dry-run and interruption after archive copy/drop are atomic',()=>{
   const db=fresh(),before=snapshot(db);assert.equal(prepareOriginalBooking(db,approved).mode,'dry-run');assert.deepEqual(snapshot(db),before);
   const exec=db.exec.bind(db);db.exec=sql=>{if(sql.startsWith('CREATE TABLE events ('))throw Error('fixture interruption');return exec(sql);};
   assert.throws(()=>prepareOriginalBooking(db,approved,{apply:true}),/fixture interruption/);db.exec=exec;assert.deepEqual(snapshot(db),before);db.close();
  });
  await t.test('apply/replay retain every source row and reconcile bindings without event identities',()=>{
   const db=fresh(),beforeSequence=db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all();
   const result=prepareOriginalBooking(db,approved,{apply:true});assert.equal(result.legacy_event_count,1);assert.equal(result.legacy_event_watermark,50);
   assert.equal(prepareOriginalBooking(db,approved,{apply:true}).action,'identical-replay');assert.equal(migrate(db),'preserved');
   for(const [table,expected] of Object.entries(payload.source_rows))assert.deepEqual(db.prepare(`SELECT * FROM ${table==='events'?'legacy_event_archive':table} ORDER BY rowid`).all(),expected);
   assert.deepEqual(db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all(),beforeSequence);
   assert.equal(db.prepare('SELECT count(*) n FROM events').get().n,0);
   assert.equal(importBookingBindings(db,approved).mode,'dry-run');assert.equal(importBookingBindings(db,approved,{apply:true}).state,'bound');
   assert.throws(()=>prepareOriginalBooking(db,approved,{apply:true}),/NEW_WORK_PRESENT/);db.close();
  });
  await t.test('CLI dry-run/apply/replay work only on a separate existing copy',()=>{
   const cli=new URL('./prepare-original-booking-cli.mjs',import.meta.url).pathname,target=join(root,'cli.sqlite');
   const args=['--directory',directory,'--approved-manifest-sha256',envelope.manifest_sha256];
   assert.throws(()=>execFileSync(process.execPath,[cli,join(directory,'source.sqlite'),...args,'--apply'],{stdio:'pipe'}));
   const privateSnapshot=join(root,'private-snapshot'),hardlink=join(root,'artifact-hardlink.sqlite');cpSync(directory,privateSnapshot,{recursive:true});linkSync(join(privateSnapshot,'source.sqlite'),hardlink);
   assert.throws(()=>execFileSync(process.execPath,[cli,hardlink,'--directory',privateSnapshot,'--approved-manifest-sha256',envelope.manifest_sha256,'--apply'],{stdio:'pipe'}));
   copyFileSync(join(directory,'source.sqlite'),target);
   const call=extra=>JSON.parse(execFileSync(process.execPath,[cli,target,...args,...extra],{encoding:'utf8',stdio:'pipe'}));
   assert.equal(call([]).mode,'dry-run');const old=new Database(target);assert.deepEqual(schemaObjects(old),ORIGINAL_SCHEMA);old.close();
   assert.equal(call(['--apply']).action,'upgrade');assert.equal(call(['--apply']).action,'identical-replay');
  });
  await t.test('new event IDs start above the archived watermark and only new events are dispatchable',()=>{
   closeDb();process.env.DB_PATH=file;
   assert.equal(listUnprocessed().length,0);
   const id=insertEvent('booking.status_changed','order',13,{status:'fixture-new-change'});assert.equal(id,51);
   assert.deepEqual(listUnprocessed().map(x=>x.id),[51]);
   assert.equal(getDb().prepare('SELECT count(*) n FROM legacy_event_archive').get().n,1);
   assert.deepEqual(getDb().prepare('SELECT * FROM legacy_event_archive').all(),payload.source_rows.events);
   assert.equal(getDb().prepare('SELECT count(*) n FROM booking_sagas').get().n,0);
   closeDb();delete process.env.DB_PATH;
  });
 }finally{closeDb();delete process.env.DB_PATH;rmSync(root,{recursive:true,force:true});}
});
