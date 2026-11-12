#!/usr/bin/env bash
# Beat 4 — find one real cross-service request trace in Jaeger.
# Uses the existing isolated 16-service acceptance; NEVER targets the useful
# local cutover deployment, resets its data, or changes tracked auth defaults.
set -euo pipefail

cd "$(dirname "$0")/.."

for command in node docker git openssl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "ERROR: Missing required command: $command" >&2
    exit 2
  fi
done
if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: Docker Compose v2 is required." >&2
  exit 2
fi
if [[ -n "${FINAL_STACK_DIRECTORY:-}" || -n "${FINAL_STACK_PROJECT:-}" ]]; then
  echo "ERROR: Unset FINAL_STACK_DIRECTORY and FINAL_STACK_PROJECT; Beat 4 requires a fresh disposable stack." >&2
  exit 2
fi
if [[ "${FINAL_STACK_KEEP:-false}" == "true" ]]; then
  echo "ERROR: FINAL_STACK_KEEP=true would retain generated credentials; Beat 4 always cleans up its isolated stack." >&2
  exit 2
fi
if [[ "${FINAL_STACK_FAULTS:-false}" == "true" || "${FINAL_STACK_RESOURCES:-false}" == "true" ]]; then
  echo "ERROR: Unset FINAL_STACK_FAULTS/FINAL_STACK_RESOURCES to keep Beat 4 scoped to trace verification." >&2
  exit 2
fi

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

echo "Beat 4: starting a NEW disposable authenticated 16-service Compose project."
echo "The runner checks real HTTP/event flows in Jaeger before its restart and"
echo "cleans up only its own test containers/volumes; existing deployments are untouched."
echo "Requires Node 22+, Docker Compose v2, OpenSSL, and free acceptance ports."
echo

if FINAL_STACK_TELEMETRY=true FINAL_STACK_KEEP=false node tests/final-stack/run.mjs | tee "$log"; then
  :
else
  echo "FAIL Beat 4: full-stack/Jaeger acceptance did not pass." >&2
  exit 1
fi

# The verifier emits a sanitized JSON line AFTER checking actual Jaeger spans,
# parent-child relationships and all three Grafana panel queries. No mock IDs.
node - "$log" <<'NODE'
const fs = require('node:fs');
const text = fs.readFileSync(process.argv[2], 'utf8');
const lines = text.split(/\r?\n/);
let telemetry;
for (const line of lines) {
  if (!line.startsWith('{"telemetry":')) continue;
  try {
    const parsed = JSON.parse(line);
    if (Array.isArray(parsed.telemetry)) telemetry = parsed.telemetry;
  } catch {}
}
if (!telemetry) {
  console.error('FAIL Beat 4: verified Jaeger telemetry summary missing.');
  process.exit(1);
}
const expected = ['provider-wallet', 'webhook-paid-booking', 'completion-notification'];
for (const name of expected) {
  const row = telemetry.find(x => x.flow === name);
  if (!row || row.edgesVerified !== true ||
      !/^[0-9a-f]{32}$/.test(row.traceId) ||
      !(row.spanCount > 1) || !Array.isArray(row.services) || row.services.length < 2) {
    console.error('FAIL Beat 4: missing/invalid real cross-service graph: ' + name);
    process.exit(1);
  }
}
console.log('\nPASS Beat 4 — actual Jaeger API verified these cross-service traces:');
for (const name of expected) {
  const row = telemetry.find(x => x.flow === name);
  console.log('  ' + name + ': traceId=' + row.traceId +
    ' | spans=' + row.spanCount + ' | services=' + row.services.join(', '));
}
console.log('Note: Jaeger uses in-memory retention. The disposable runner restarts');
console.log('and cleans up the stack; trace IDs are evidence of checks during the run,');
console.log('not links to permanently retained traces.');
NODE
