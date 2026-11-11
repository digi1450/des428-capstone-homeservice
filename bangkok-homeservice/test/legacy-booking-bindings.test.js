import {configureLegacyBookingApproval,resetLegacyBookingApproval} from '../lib/modules/booking/legacy-binding.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,copyFileSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import Database from 'better-sqlite3';
import {loadApprovedSnapshot} from '../../tools/data-migration/approved-snapshot.mjs';
import {importBookingBindings} from '../../tools/data-migration/booking-bindings.mjs';
import {legacyBookingReference} from '../lib/modules/booking/legacy-binding.js';
import {paymentSetupFor} from '../lib/modules/booking/saga.js';
import {getDb,closeDb} from '../lib/db/index.js';
test('offline Booking binding dry-run/replay/source conflicts and checkpoint readiness',async()=>{
 const root=mkdtempSync(join(tmpdir(),'booking-binding-fixture-'));
 try{
  execFileSync('python3',['-B','-c',"from pathlib import Path; import sys; from test_export import make_source,module; p=Path(sys.argv[1]);make_source(p/'source.sqlite');module.export_snapshot(p/'source.sqlite',p/'snapshot',writers_stopped=True)",root],{cwd:resolve('../tools/data-migration')});
  const directory=join(root,'snapshot');const manifest=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'));
  const approved=await loadApprovedSnapshot(directory,manifest.manifest_sha256);
  const file=join(root,'target.sqlite');copyFileSync(join(directory,'source.sqlite'),file);
  const db=new Database(file);db.pragma('foreign_keys=ON');
  const before=db.serialize();
  assert.equal(importBookingBindings(db,approved).mode,'dry-run');assert.deepEqual(db.serialize(),before);
  assert.equal(importBookingBindings(db,approved,{apply:true}).bindings,2);
  assert.equal(importBookingBindings(db,approved,{apply:true}).action,'identical-replay');
  db.prepare('UPDATE orders SET total_cents=total_cents+1 WHERE id=13').run();
  assert.throws(()=>importBookingBindings(db,approved,{apply:true}));db.prepare('UPDATE orders SET total_cents=total_cents-1 WHERE id=13').run();
  db.close();
  process.env.DB_PATH=file;closeDb();
  assert.equal(paymentSetupFor(13),null);assert.equal(legacyBookingReference(13),null);
  assert.throws(()=>configureLegacyBookingApproval(manifest.manifest_sha256));
  // Synthetic operator checkpoint only. Production approval belongs to step2.
  getDb().prepare("UPDATE booking_legacy_payment_checkpoints SET state='approved'").run();
  configureLegacyBookingApproval(manifest.manifest_sha256);
  assert.equal(paymentSetupFor(13),'ready');assert.equal(legacyBookingReference(13).manifest_sha256,manifest.manifest_sha256);
  getDb().prepare('UPDATE orders SET total_cents=total_cents+1 WHERE id=13').run();
  assert.equal(paymentSetupFor(13),null);closeDb();delete process.env.DB_PATH;
 }finally{resetLegacyBookingApproval();closeDb();delete process.env.DB_PATH;rmSync(root,{recursive:true,force:true});}
});
