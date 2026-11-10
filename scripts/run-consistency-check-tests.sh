#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
project="homeservice-c-check-${GITHUB_RUN_ID:-local-$$}-${GITHUB_RUN_ATTEMPT:-1}"
compose=(docker compose -p "$project" -f "$root/tests/consistency/compose.yml")
# Never adopt a previously running/retained project, even on an interrupted local run.
[[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ]]
cleanup(){ "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT
"${compose[@]}" build checker
"${compose[@]}" up -d --wait --wait-timeout 150 payments-db rabbitmq
"${compose[@]}" run --rm --no-deps checker
