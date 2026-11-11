import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, cp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadApprovedSnapshot} from './approved-snapshot.mjs';
import {importApprovedSnapshot,importSnapshot} from './import-snapshot.mjs';
import {createDatabase} from '../../services/payments-wallet/src/database.js';
import {migrate} from '../../services/payments-wallet/src/migrations.js';
const directory=process.env.SNAPSHOT_FIXTURE_DIR;
const envelope=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
const digest=envelope.manifest_sha256;
test('approved import captures verified bytes and atomically applies/replays bindings',async t=>{
 const db=createDatabase(process.env.PAYMENTS_TEST_URL);
 // Each test file uses its OWN schema to isolate from the old importer tests.
 const schema='approved_import_fixture';
 await db.query(`CREATE SCHEMA ${schema}`);
 const url=new URL(process.env.PAYMENTS_TEST_URL);url.searchParams.set('options',`-c search_path=${schema}`);
 const own=createDatabase(url.toString());
 const reset=()=>own.query('TRUNCATE payment_provisioning,legacy_payment_bindings,webhook_events,transactions,provider_wallets,payment_intents');
 const capture=async()=>({bindings:(await own.query('SELECT * FROM legacy_payment_bindings ORDER BY order_id')).rows,
 intents:(await own.query('SELECT * FROM payment_intents ORDER BY id')).rows,
 sequence:(await own.query('SELECT last_value,is_called FROM payment_intents_id_seq')).rows});
 try {
  await migrate(own);
  const approved=await loadApprovedSnapshot(directory,digest);
  await t.test('forged approval and changed bundle rejected before target access',async()=>{
   await assert.rejects(importApprovedSnapshot(own,'payments-wallet',{manifest_sha256:digest}),/VERIFIED/);
   const bundle=JSON.parse(await readFile(join(directory,'payments-wallet.json'),'utf8'));bundle.snapshot_id='changed';
   await assert.rejects(importSnapshot(own,'payments-wallet',bundle,{approved}),/APPROVED_BUNDLE/);
   await assert.rejects(loadApprovedSnapshot(directory,'0'.repeat(64)),/PREFLIGHT/);
  });
  await t.test('dry-run rolls back business rows, bindings and sequences',async()=>{
   const before=await capture();const result=await importApprovedSnapshot(own,'payments-wallet',approved);
   assert.equal(result.bindings,2);assert.equal(result.mode,'dry-run');assert.deepEqual(await capture(),before);
  });
  await t.test('approved CLI defaults to dry-run and sanitizes verification errors',async()=>{
   const args=['import-cli.mjs','payments-wallet','--approved-directory',directory,'--expected-manifest-sha256',digest];
   const env={...process.env,DATABASE_URL:url.toString()};
   const before=await capture();
   const result=JSON.parse(execFileSync(process.execPath,args,{env,encoding:'utf8'}));
   assert.equal(result.mode,'dry-run');assert.equal(result.bindings,2);assert.equal(result.manifest_sha256,digest);
   assert.deepEqual(await capture(),before);
   assert.throws(()=>execFileSync(process.execPath,[...args.slice(0,-1),'0'.repeat(64)],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']}),error=>{
    assert.match(error.stderr,/IMPORT_REJECTED/);assert.equal(error.stdout,'');
    assert.ok(!error.stderr.includes('migration-fixture-only'));return true;
   });
  });
  await t.test('binding insert failure rolls back earlier business rows',async()=>{
   await own.query("CREATE FUNCTION reject_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$");
   await own.query('CREATE TRIGGER reject_binding BEFORE INSERT ON legacy_payment_bindings FOR EACH ROW EXECUTE FUNCTION reject_binding()');
   const before=await capture();
   await assert.rejects(importApprovedSnapshot(own,'payments-wallet',approved,{apply:true}),/fixture/);
   assert.deepEqual(await capture(),before);
   await own.query('DROP TRIGGER reject_binding ON legacy_payment_bindings');
  });
  await t.test('apply writes exact bindings and replay preserves created_at',async()=>{
   await importApprovedSnapshot(own,'payments-wallet',approved,{apply:true});
   const before=await capture();assert.equal(before.bindings.length,2);
   for(const entry of envelope.manifest.bindings){const actual=before.bindings.find(x=>x.order_id===entry.order_id);
    assert.equal(actual.binding_id,`legacy:${digest}:${entry.order_id}`);
    for(const key of ['intent_id','customer_id','provider_id','amount_cents','currency','eligibility'])assert.equal(actual[key],entry[key]);}
   assert.equal((await importApprovedSnapshot(own,'payments-wallet',approved,{apply:true})).action,'identical-replay');
   assert.deepEqual(await capture(),before);
   await assert.rejects(importSnapshot(own,'payments-wallet',JSON.parse(await readFile(join(directory,'payments-wallet.json'),'utf8')),{apply:true}),/MESSAGE_STATE_NOT_EMPTY/);
  });
  await t.test('partial bindings, changed manifest and active commands reject without repair',async()=>{
   await own.query('DELETE FROM legacy_payment_bindings WHERE order_id=$1',[envelope.manifest.bindings[0].order_id]);
   const before=await capture();await assert.rejects(importApprovedSnapshot(own,'payments-wallet',approved,{apply:true}),/BINDING_TARGET/);
   assert.deepEqual(await capture(),before);
   await reset();await importApprovedSnapshot(own,'payments-wallet',approved,{apply:true});
   await own.query("UPDATE legacy_payment_bindings SET manifest_sha256=repeat('a',64),binding_id='legacy:'||repeat('a',64)||':'||order_id");
   await assert.rejects(importApprovedSnapshot(own,'payments-wallet',approved,{apply:true}),/BINDING_TARGET/);
   await reset();
   await own.query("INSERT INTO outbox_events(event_id,event_type,aggregate_type,aggregate_id,envelope) VALUES ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','payment.succeeded','order','13','{}')");
   await assert.rejects(importApprovedSnapshot(own,'payments-wallet',approved,{apply:true}),/MESSAGE_STATE_NOT_EMPTY/);
   assert.equal((await own.query('SELECT count(*)::int n FROM payment_intents')).rows[0].n,0);
  });
  await t.test('captured source survives replacement after verification without reread',async()=>{
   const temp=await mkdtemp(join(tmpdir(),'approved-fixture-'));
   try {await cp(directory,join(temp,'snapshot'),{recursive:true});
    const handle=await loadApprovedSnapshot(join(temp,'snapshot'),digest);
    await writeFile(join(temp,'snapshot','payments-wallet.json'),'{}');
    await own.query('DELETE FROM outbox_events');await reset();
    await importApprovedSnapshot(own,'payments-wallet',handle,{apply:true});
    assert.equal((await capture()).bindings.length,2);
    await assert.rejects(loadApprovedSnapshot(join(temp,'snapshot'),digest),/PREFLIGHT/);
   }finally{await rm(temp,{recursive:true,force:true});}
  });
 }finally{await own.close();await db.query(`DROP SCHEMA ${schema} CASCADE`);await db.close();}
});
