import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from test_export import make_source, module
from verify_manifest import verify_manifest, ExportError

class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name); make_source(self.root/'source.sqlite')
        module.export_snapshot(self.root/'source.sqlite',self.root/'snapshot',writers_stopped=True)
        self.directory=self.root/'snapshot'
        self.envelope=json.loads((self.directory/'manifest.json').read_bytes())
    def publish(self):
        core=self.envelope['manifest']
        self.envelope['manifest_sha256']=hashlib.sha256(module.canonical_bytes(core)).hexdigest()
        (self.directory/'manifest.json').write_bytes(module.canonical_bytes(self.envelope)+b'\n')
        return self.envelope['manifest_sha256']
    def test_verified_package_preserves_every_original_byte(self):
        before={p.name:p.read_bytes() for p in self.directory.iterdir()}
        result=verify_manifest(self.directory,self.envelope['manifest_sha256'])
        self.assertEqual(result['bindings'],2)
        self.assertEqual(before,{p.name:p.read_bytes() for p in self.directory.iterdir()})
    def test_wrong_external_approval_digest_is_rejected(self):
        with self.assertRaisesRegex(ExportError,'APPROVED_MANIFEST_HASH_MISMATCH'):
            verify_manifest(self.directory,'0'*64)
    def test_omitting_binding_and_rehashing_cannot_hide_eligible_order(self):
        self.envelope['manifest']['bindings'].pop()
        with self.assertRaisesRegex(ExportError,'SOURCE_MANIFEST_MISMATCH'):
            verify_manifest(self.directory,self.publish())
    def test_changed_owner_bundle_and_rehashing_cannot_override_source(self):
        path=self.directory/'notifications.json'; bundle=json.loads(path.read_bytes())
        bundle['tables']['notifications'][0]['body']='changed'
        path.write_bytes(json.dumps(bundle).encode())
        self.envelope['manifest']['bundles'][0]['sha256']=hashlib.sha256(path.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ExportError,'SOURCE_BUNDLE_MISMATCH'):
            verify_manifest(self.directory,self.publish())
    def test_changed_source_schema_fingerprint_is_rejected(self):
        self.envelope['manifest']['source']['schema_fingerprint']='0'*64
        with self.assertRaisesRegex(ExportError,'SOURCE_MANIFEST_MISMATCH'):
            verify_manifest(self.directory,self.publish())
    def test_backup_bytes_are_not_trusted_by_filename(self):
        with (self.directory/'source.sqlite').open('ab') as handle: handle.write(b'changed')
        with self.assertRaisesRegex(ExportError,'BACKUP_HASH'):
            verify_manifest(self.directory,self.envelope['manifest_sha256'])
    def test_source_change_with_matching_hash_still_requires_bundle_context(self):
        with sqlite3.connect(self.directory/'source.sqlite') as db:
            db.execute("UPDATE notifications SET body='Changed source' WHERE id=70")
        self.envelope['manifest']['source']['sqlite_backup_sha256']=hashlib.sha256((self.directory/'source.sqlite').read_bytes()).hexdigest()
        with self.assertRaisesRegex(ExportError,'SOURCE_BUNDLE_MISMATCH'):
            verify_manifest(self.directory,self.publish())
    def test_noncanonical_and_symlink_inputs_rejected(self):
        original=(self.directory/'manifest.json').read_bytes()
        (self.directory/'manifest.json').write_text(json.dumps(self.envelope,indent=2))
        with self.assertRaisesRegex(ExportError,'NON_CANONICAL_MANIFEST'):
            verify_manifest(self.directory,self.envelope['manifest_sha256'])
        (self.directory/'manifest.json').write_bytes(original)
        p=self.directory/'source.sqlite';p.rename(self.root/'backup.sqlite');p.symlink_to(self.root/'backup.sqlite')
        with self.assertRaisesRegex(ExportError,'ARTIFACT_FILE_REQUIRED'):
            verify_manifest(self.directory,self.envelope['manifest_sha256'])
