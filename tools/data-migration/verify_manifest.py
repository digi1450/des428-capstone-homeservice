"""Offline preflight only. Does not connect to service databases or apply bindings."""
import argparse
import hashlib
import json
from pathlib import Path
import tempfile
import uuid
from export_snapshot import export_snapshot, canonical_bytes, require, ExportError


def verify_manifest(directory, expected_digest):
    directory = Path(directory)
    require(isinstance(expected_digest, str) and len(expected_digest) == 64 and
            all(c in '0123456789abcdef' for c in expected_digest), 'INVALID_APPROVED_DIGEST')
    def read(name):
        path = directory/name
        require(path.is_file() and not path.is_symlink(), 'ARTIFACT_FILE_REQUIRED')
        return path.read_bytes()
    raw = read('manifest.json')
    envelope = json.loads(raw.decode('utf-8'))
    require(type(envelope) is dict and set(envelope) == {'manifest', 'manifest_sha256'}, 'MANIFEST_ENVELOPE')
    require(raw in (canonical_bytes(envelope), canonical_bytes(envelope)+b'\n'), 'NON_CANONICAL_MANIFEST')
    core = envelope['manifest']
    require(hashlib.sha256(canonical_bytes(core)).hexdigest() == expected_digest == envelope['manifest_sha256'],
            'APPROVED_MANIFEST_HASH_MISMATCH')
    require(type(core) is dict and set(core) == {'format_version','snapshot_id','source','legacy_event_watermark','bundles','bindings'}, 'MANIFEST_FIELDS')
    require(str(uuid.UUID(core['snapshot_id'])) == core['snapshot_id'], 'SNAPSHOT_ID')
    backup = read('source.sqlite')
    require(hashlib.sha256(backup).hexdigest() == core['source']['sqlite_backup_sha256'], 'BACKUP_HASH')
    bundles = {}
    for name in ('notifications', 'payments-wallet'):
        content = read(name+'.json')
        bundles[name] = (content, json.loads(content.decode('utf-8')))
    # Re-run the source classifier against a PRIVATE COPY. Never open or alter
    # the approved backup or its possible journal/sidecar files through SQLite.
    with tempfile.TemporaryDirectory(prefix='homeservice-manifest-verify-') as temp:
        temp = Path(temp)
        copied = temp/'source.sqlite'
        copied.write_bytes(backup)
        copied.chmod(0o600)
        export_snapshot(copied, temp/'regenerated', writers_stopped=True)
        regenerated = json.loads((temp/'regenerated/manifest.json').read_bytes())['manifest']
        for name, (content, original) in bundles.items():
            generated = json.loads((temp/'regenerated'/(name+'.json')).read_bytes())
            require(original['snapshot_id'] == core['snapshot_id'], 'BUNDLE_SNAPSHOT_MISMATCH')
            # Only regenerated invocation metadata may differ. The full original
            # bundle, including owner/table/header fields, must otherwise match.
            generated['snapshot_id'] = core['snapshot_id']
            generated['exported_at'] = original['exported_at']
            require(canonical_bytes(generated) == canonical_bytes(original), 'SOURCE_BUNDLE_MISMATCH')
        require(bundles['notifications'][1]['exported_at'] == bundles['payments-wallet'][1]['exported_at'], 'BUNDLE_TIME_MISMATCH')
        regenerated['snapshot_id'] = core['snapshot_id']
        regenerated['source']['sqlite_backup_sha256'] = hashlib.sha256(backup).hexdigest()
        regenerated['bundles'] = [dict(service=name, file=name+'.json', sha256=hashlib.sha256(bundles[name][0]).hexdigest())
                                  for name in ('notifications','payments-wallet')]
        require(canonical_bytes(regenerated) == canonical_bytes(core), 'SOURCE_MANIFEST_MISMATCH')
    return dict(status='verified', manifest_sha256=expected_digest,
                snapshot_id=core['snapshot_id'], bindings=len(core['bindings']))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True)
    parser.add_argument('--expected-manifest-sha256', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(verify_manifest(args.directory, args.expected_manifest_sha256)))
    except Exception:
        # Never echo parser/SQLite/path errors or source rows.
        print(json.dumps(dict(error='MANIFEST_PREFLIGHT_REJECTED')))
        return 1
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
