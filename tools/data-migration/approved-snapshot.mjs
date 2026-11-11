// Offline private IPC; never expose payloads in reports, logs or evidence.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const run = promisify(execFile), verified = new WeakMap();
const directory = fileURLToPath(new URL('.', import.meta.url));
export async function loadApprovedSnapshot(path, digest) {
  try {
    const {stdout} = await run('python3', ['-B', '-c',
      'import json,sys; from verify_manifest import verify_manifest; print(json.dumps(verify_manifest(sys.argv[1],sys.argv[2],capture=True)))',
      path, digest], {cwd:directory, maxBuffer:64*1024*1024, timeout:120000});
    const payload = JSON.parse(stdout);
    const handle = Object.freeze({...payload.report});
    verified.set(handle,payload);
    return handle;
  } catch { throw new Error('MANIFEST_PREFLIGHT_REJECTED'); }
}
export function approvedPayload(handle) {
  const payload = verified.get(handle);
  if (!payload) throw new Error('VERIFIED_MANIFEST_REQUIRED');
  // The caller cannot mutate the retained proof between validation and SQL.
  return structuredClone(payload);
}
