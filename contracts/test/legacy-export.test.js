import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {parseManifestEnvelope,assertManifestArtifacts} from '../validation/legacy-payment-manifest.mjs';

test('actual SQLite exporter agrees with independent JS manifest/schema/artifact reference',()=>{
 const directory=mkdtempSync(join(tmpdir(),'homeservice-manifest-conformance-'));
 const root=fileURLToPath(new URL('../../',import.meta.url));
 try{
  execFileSync('python3',['-B','-c',`import importlib.util,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('fixtures','tools/data-migration/test_export.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
p=Path(sys.argv[1]);m.make_source(p/'source.sqlite')
m.module.export_snapshot(p/'source.sqlite',p/'snapshot',writers_stopped=True)
`,directory],{cwd:root});
  const read=name=>readFileSync(join(directory,'snapshot',name));
  const envelope=parseManifestEnvelope(read('manifest.json'));
  assertManifestArtifacts(envelope,{backupBytes:read('source.sqlite'),bundleBytes:{notifications:read('notifications.json'),'payments-wallet':read('payments-wallet.json')}});
  assert.deepEqual(envelope.manifest.bindings.map(x=>x.eligibility),['open_unpaid','open_paid']);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
