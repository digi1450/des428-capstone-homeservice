#!/bin/sh
# Run from any directory. This project contains only disposable echo fixtures.
set -eu
cd "$(dirname "$0")/../.."
compose() { docker compose -p homeservice-gateway-test -f tests/gateway/compose.yml "$@"; }
trap 'compose down --remove-orphans' EXIT
compose config --quiet
compose up -d edemand notifications payments-wallet baseline candidate
compose exec -T baseline nginx -t
compose exec -T candidate nginx -t
compose run --rm test routing.test.mjs
compose stop notifications
# nginx must also be startable while a service hostname has no live container.
compose up -d --force-recreate candidate
compose exec -T candidate nginx -t
compose run --rm test outage.test.mjs
# Recreate the backend to exercise Docker DNS re-resolution; nginx stays running.
compose up -d --force-recreate notifications
compose run --rm test recovery.test.mjs
