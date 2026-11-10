#!/usr/bin/env bash
# Isolated destructive queue tests. Never use the application Compose project.
set -euo pipefail
cd "$(dirname "$0")/.."
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-homeservice-e-ci-$(date +%s)-$$}"
case "$COMPOSE_PROJECT_NAME" in
  homeservice-e-ci-*) ;;
  *) echo 'Use a new homeservice-e-ci-* disposable project.' >&2; exit 2 ;;
esac
compose=(docker compose -f tests/e2e-tracing/compose.yml)
if [[ -n "$("${compose[@]}" ps -aq)" ]]; then
  echo 'Project already has containers; refusing to touch it.' >&2
  exit 2
fi
cleanup() {
  local result=$?
  trap - EXIT
  if (( result != 0 )); then "${compose[@]}" logs --no-color --tail=100 >&2 || true; fi
  "${compose[@]}" down --volumes --remove-orphans || { (( result != 0 )) || result=1; }
  exit "$result"
}
trap cleanup EXIT
run_suite() {
  local output
  output=$(mktemp)
  "${compose[@]}" run --rm "$@" | tee "$output"
  # Node's TAP summary must show actual executed tests, with no skipped cases.
  grep -Eq '^# tests [1-9][0-9]*$' "$output"
  grep -Eq '^# fail 0$' "$output"
  grep -Eq '^# skipped 0$' "$output"
  rm -f "$output"
}
"${compose[@]}" build test-runner reliability-test
run_suite test-runner
# Lifecycle deliberately changes broker topology. Keep these phases sequential.
run_suite reliability-test
run_suite reliability-test node --test services/payments-wallet/test/outbox.test.js
