import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {assertManifestCore,canonicalManifestCore,manifestDigest,createManifestEnvelope,assertManifestEnvelope,deriveLegacyBindingId,serializeManifestEnvelope,parseManifestEnvelope,assertManifestArtifacts,assertLegacyManifestContext,bindingRowsFor} from '../validation/legacy-payment-manifest.mjs';
const dir=new URL('../fixtures/legacy-payment-manifest/',import.meta.url);
const load=async name=>JSON.parse(await readFile(new URL(name,dir),'utf8'));
const core=await load('core.json'),envelope=await load('manifest.json'),golden=await load('golden.json');
const backupBytes=await readFile(new URL('backup.fixture.txt',dir));
const bundleBytes=Object.fromEntries(await Promise.all(['notifications','payments-wallet'].map(async name=>[name,await readFile(new URL(name+'.json',dir))])));
const copy=x=>structuredClone(x),sha=x=>createHash('sha256').update(x).digest('hex');

test('strict envelope/core and sorted unique binding identities match independently generated golden bytes',()=>{
 assert.equal(canonicalManifestCore(core).toString('hex'),golden.canonical_utf8_hex);
 assert.equal(manifestDigest(core),golden.manifest_sha256);
 assert.deepEqual(createManifestEnvelope(core),envelope);
 assert.deepEqual(assertManifestEnvelope(envelope),envelope);
 for(const row of core.bindings)assert.equal(deriveLegacyBindingId(envelope.manifest_sha256,row.order_id),golden.binding_ids[row.order_id]);
 assert.equal(Object.hasOwn(core.bindings[0],'binding_id'),false,'no circular hash');
 const reordered=Object.fromEntries(Object.entries(core).reverse());assert.equal(manifestDigest(reordered),golden.manifest_sha256);
});
test('Python3 independently agrees on exact UTF8 bytes and SHA256',()=>{
 const script=fileURLToPath(new URL('../validation/canonical_manifest.py',import.meta.url));
 const result=spawnSync('python3',[script],{input:JSON.stringify(core),encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);const actual=JSON.parse(result.stdout);
 assert.equal(actual.canonical_utf8_hex,golden.canonical_utf8_hex);assert.equal(actual.manifest_sha256,golden.manifest_sha256);
 for(const input of ['{"x":1,"x":2}','{"x":1.25}','{"x":9007199254740992}','{"x":true}','{"x":NaN}'])assert.notEqual(spawnSync('python3',[script],{input,encoding:'utf8'}).status,0);
});
test('canonical file parser rejects duplicate keys, BOM, invalid UTF8 and misleading encodings',()=>{
 const file=serializeManifestEnvelope(envelope);assert.deepEqual(parseManifestEnvelope(file),envelope);
 assert.deepEqual(parseManifestEnvelope(file.subarray(0,-1)),envelope);
 for(const bytes of [Buffer.from(JSON.stringify(envelope,null,2)),Buffer.concat([Buffer.from([239,187,191]),file]),Buffer.from([255,254]),Buffer.concat([file,Buffer.from('\n')]),Buffer.from(file.toString().replace('"manifest":','"manifest_sha256":"'+envelope.manifest_sha256+'","manifest":'))])assert.throws(()=>parseManifestEnvelope(bytes),TypeError);
});
test('strict metadata rejects floats, unsafe/ranged IDs, private/unknown data and mixed cohort states',()=>{
 const changes=[x=>x.extra='secret',x=>x.bindings[0].amount_cents=1.25,x=>x.legacy_event_watermark=Number.MAX_SAFE_INTEGER+1,x=>x.bindings[0].order_id=0,x=>x.bindings[0].intent_id=2147483647,x=>x.bindings[0].amount_cents=2147483647,x=>x.source.schema_fingerprint='0'.repeat(63),x=>x.source.schema_fingerprint='0'.repeat(64)+'\n',x=>x.snapshot_id+='\n',x=>x.bindings[0].currency='USD',x=>x.bindings[0].payment_method='cod',x=>x.bindings[0].eligibility='other',x=>x.bindings[0].order_status='completed',x=>x.bindings[0].payment_status='paid',x=>x.bindings[0].charge_transaction_id=140,x=>delete x.bindings[1].charge_transaction_id,x=>x.bindings[1].intent_status='failed',x=>x.bindings[0].binding_id='circular',x=>x.source.password='secret'];
 for(const change of changes){const value=copy(core);change(value);assert.throws(()=>assertManifestCore(value),TypeError);}
});
test('duplicate/order-swapped bundles, orders, intents and charge IDs cannot share a manifest',()=>{
 const changes=[x=>x.bundles.reverse(),x=>x.bundles[1]={...x.bundles[0]},x=>x.bundles[0].file='../private.json',x=>x.bindings.reverse(),x=>x.bindings[1].order_id=x.bindings[0].order_id,x=>x.bindings[1].intent_id=x.bindings[0].intent_id,x=>x.bindings.push({...x.bindings[1],order_id:15,intent_id:47})];
 for(const change of changes){const value=copy(core);change(value);assert.throws(()=>createManifestEnvelope(value),TypeError);}
 assert.doesNotThrow(()=>createManifestEnvelope({...core,bindings:[]}),'terminal-only snapshot can have no eligible bindings');
});
test('core tampering requires a new full hash; identity derives exact order and hash',()=>{
 const changed=copy(envelope);changed.manifest.bindings[0].amount_cents++;
 assert.throws(()=>assertManifestEnvelope(changed),TypeError);
 assert.throws(()=>deriveLegacyBindingId('A'.repeat(64),13),TypeError);
 for(const id of [0,-1,'13',2147483648,1.25])assert.throws(()=>deriveLegacyBindingId(envelope.manifest_sha256,id),TypeError);
});
test('raw artifact digests/header/watermark and eligible financial references agree',()=>{
 assert.doesNotThrow(()=>assertManifestArtifacts(envelope,{backupBytes,bundleBytes}));
 assert.throws(()=>assertManifestArtifacts(envelope,{backupBytes:Buffer.from('changed'),bundleBytes}),TypeError);
 assert.throws(()=>assertManifestArtifacts(envelope,{backupBytes,bundleBytes:{...bundleBytes,notifications:Buffer.concat([bundleBytes.notifications,Buffer.from(' ')])}}),TypeError);
 for(const mutate of [p=>p.snapshot_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',p=>p.legacy_event_watermark++,p=>p.tables.payment_intents[0].provider_id++,p=>p.tables.transactions.push({...p.tables.transactions[0],id:141,kind:'refund'}),p=>p.tables.transactions[0].amount_cents++,p=>p.tables.transactions[0].gateway_ref='changed',p=>p.tables.transactions[0].id++,p=>p.tables.transactions.push({...p.tables.transactions[0],id:141,order_id:13})]){
  const pay=JSON.parse(bundleBytes['payments-wallet']);mutate(pay);const bytes=Buffer.from(JSON.stringify(pay));const value=copy(core);value.bundles[1].sha256=sha(bytes);
  assert.throws(()=>assertManifestArtifacts(createManifestEnvelope(value),{backupBytes,bundleBytes:{...bundleBytes,'payments-wallet':bytes}}),TypeError);
 }
});
test('manifest context check rejects a valid-looking reference for another owner/amount/hash',()=>{
 const row=core.bindings[0],request={order_id:row.order_id,customer_id:row.customer_id,provider_id:row.provider_id,amount_cents:row.amount_cents,currency:row.currency,payment_method:'gateway',legacy_binding:{binding_id:golden.binding_ids[row.order_id],manifest_sha256:golden.manifest_sha256}};
 assert.equal(assertLegacyManifestContext(request,envelope).intent_id,row.intent_id);
 for(const value of [{...request,customer_id:99},{...request,provider_id:99},{...request,amount_cents:99},{...request,currency:'USD'},{...request,legacy_binding:{...request.legacy_binding,binding_id:golden.binding_ids['14']}},{...request,legacy_binding:{binding_id:deriveLegacyBindingId('f'.repeat(64),13),manifest_sha256:'f'.repeat(64)}}])assert.throws(()=>assertLegacyManifestContext(value,envelope),TypeError);
});

test('owner binding projections match exact shared fixtures and carry no invented command identity',async()=>{
 const rows=await load('binding-rows.json');
 for(const owner of ['booking','payments-wallet']){
  assert.deepEqual(bindingRowsFor(envelope,owner),rows[owner]);
  for(const row of rows[owner])for(const key of ['created_at','operation_id','saga_id','create_command_id'])assert.equal(Object.hasOwn(row,key),false);
 }
 assert.throws(()=>bindingRowsFor(envelope,'notifications'),TypeError);
 assert.deepEqual(bindingRowsFor(createManifestEnvelope({...core,bindings:[]}),'booking'),[]);
});
