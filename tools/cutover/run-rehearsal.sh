#!/bin/sh
set -eu
umask 077
root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
name=homeservice-cutover-rehearsal-$$
fixtures=$(mktemp -d /tmp/homeservice-cutover-fixtures.XXXXXX)
cleanup(){ docker rm -f "$name-payments" "$name-notifications" "$name-broker" >/dev/null 2>&1 || true; docker network rm "$name" >/dev/null 2>&1 || true; rm -rf "$fixtures"; }
trap cleanup EXIT
mkdir "$fixtures/backups" "$fixtures/image"
image=${CUTOVER_TEST_IMAGE:-homeservice-cutover-test:local}
if [ -z "${CUTOVER_TEST_IMAGE:-}" ]; then
 cp "$root/bangkok-homeservice/package.json" "$root/bangkok-homeservice/package-lock.json" "$fixtures/image/"
 cp "$root/tools/cutover/Dockerfile.test" "$fixtures/image/Dockerfile"
 docker build -t "$image" "$fixtures/image"
fi
python3 -B - "$root" "$fixtures" <<'PY'
import sys,shutil
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[1])/'tools/data-migration'))
from test_export import make_source,module
root=Path(sys.argv[2]);make_source(root/'source.sqlite');module.export_snapshot(root/'source.sqlite',root/'snapshot',writers_stopped=True)
shutil.copyfile(root/'snapshot/source.sqlite',root/'backups/source.sqlite');(root/'backups/source.sqlite').chmod(0o600)
# Synthetic original36-object baseline, never the user's source database.
import sqlite3
old=root/'original.sqlite';make_source(old)
db=sqlite3.connect(old)
for name in ['booking_financial_work','booking_legacy_payment_bindings','booking_legacy_payment_checkpoints','booking_saga_activations','booking_saga_transitions','booking_sagas','booking_work_trace_context','consistency_attention','event_trace_context','processed_events','legacy_event_archive']:
    db.execute('DROP TABLE '+name)
db.execute('DROP TABLE events')
db.execute("""CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at TEXT
)""")
db.execute('CREATE INDEX idx_events_unprocessed ON events(processed_at) WHERE processed_at IS NULL')
db.execute("INSERT INTO events VALUES(50,'booking.completed','order',10,'{\"historical\":true}','2026-11-06T00:00:00.000Z','2026-11-06T00:00:00.000Z')")
db.commit();db.close();module.export_snapshot(old,root/'original-snapshot',writers_stopped=True)
unknown=root/'unknown-original.sqlite';shutil.copyfile(old,unknown)
with sqlite3.connect(unknown) as db: db.execute('CREATE TABLE unexpected_source_metadata(id INTEGER)')
module.export_snapshot(unknown,root/'unknown-original-snapshot',writers_stopped=True)


PY
docker network create "$name" >/dev/null
for owner in payments notifications; do
 docker run -d --name "$name-$owner" --network "$name" --network-alias "$owner" --tmpfs /var/lib/postgresql/data -e POSTGRES_USER=fixture -e POSTGRES_PASSWORD=fixture -e POSTGRES_DB=fixture postgres:16-alpine >/dev/null
 for n in $(seq 1 40); do if docker exec "$name-$owner" pg_isready -U fixture -d fixture >/dev/null 2>&1; then break; fi; sleep 1; done
 docker exec "$name-$owner" pg_dump -U fixture -d fixture -Fc > "$fixtures/backups/$owner-before.dump"
done
docker run -d --user 100:101 --tmpfs /var/lib/rabbitmq:uid=100,gid=101,mode=700 --name "$name-broker" --network "$name" --network-alias broker -e RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS='+S 2:2 +SDcpu 1 +SDio 1' -e RABBITMQ_DEFAULT_USER=fixture -e RABBITMQ_DEFAULT_PASS=fixture rabbitmq:4.1-management-alpine >/dev/null
for n in $(seq 1 40); do if docker exec "$name-broker" rabbitmq-diagnostics -q check_running >/dev/null 2>&1; then break; fi; sleep 1; done
if ! docker exec "$name-broker" rabbitmq-diagnostics -q check_port_connectivity >/dev/null 2>&1; then docker logs "$name-broker"; exit 1; fi
docker run --rm --network "$name" -e CUTOVER_FIXTURE_DIR=/fixtures -e CUTOVER_PAYMENTS_URL=postgres://fixture:fixture@payments:5432/fixture -e CUTOVER_NOTIFICATIONS_URL=postgres://fixture:fixture@notifications:5432/fixture -e CUTOVER_AMQP_URL=amqp://fixture:fixture@broker:5672?frameMax=131072 -e CUTOVER_BROKER_MANAGEMENT_URL=http://broker:15672 -e NODE_ENV=test -e LOG_LEVEL=silent -v "$root/bangkok-homeservice/lib:/app/lib:ro" -v "$root/bangkok-homeservice/package.json:/app/package.json:ro" -v "$root/tools:/tools:ro" -v "$root/services:/services:ro" -v "$root/contracts:/contracts:ro" -v "$fixtures:/fixtures:ro" -w /app "$image" node --test --test-concurrency=1 /tools/cutover/checkpoint.test.mjs /tools/data-migration/original-booking-schema.test.mjs
# Restore BOTH real custom-format dumps into new test-owned databases, never
# overlay them onto a database with post-cutover writes.
for owner in payments notifications; do
 docker exec "$name-$owner" createdb -U fixture restored
 docker exec -i "$name-$owner" pg_restore -U fixture -d restored < "$fixtures/backups/$owner-before.dump"
 count=$(docker exec "$name-$owner" psql -U fixture -d restored -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
 test "$count" = 0
done
echo 'PASS actual pg_dump/pg_restore into fresh owners preserves the pre-import empty target checkpoint'
