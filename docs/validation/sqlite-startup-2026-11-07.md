# Non-destructive SQLite startup — 7 November 2026

Scope: isolated monolith startup/persistence checks from task branch `fix/a-persistent-monolith-startup`, based on merged PR #22 (`1492df2`). No useful database, existing application container or real migration was started/reset.

## Reproducible checks

From repository root:

```sh
docker compose -p homeservice-startup-tests -f bangkok-homeservice/docker-compose.yml config --quiet
docker compose -p homeservice-startup-tests -f bangkok-homeservice/docker-compose.yml run --rm --build test
docker build --target runtime -t homeservice-startup-runtime bangkok-homeservice
python3 tests/integration/monolith-startup-runtime.py
git diff --check
```

- Node 20 Docker monolith suite: **121 tests passed, 0 failed, 0 skipped** (114 inherited tests plus 7 startup tests). New tests use temporary file databases/in-memory databases. The file-database checks boot real separate processes and compare every table's rows across restart, including Booking, slot holds, saga state/history, pending event UUID/retry/lease, consumer dedupe, idempotency and sequences. The suite also covers adoption without reseed, rollback on seed failure, incompatible/partial/index/version rejection without row changes, file-reset prohibition, explicit in-memory reset and two concurrent initializing processes.
- Production standalone image build: passed, including Next's native SQLite dependency tracing.
- Standalone runtime: health passed on an empty dedicated volume. Updated seeded data/sequence then compared every table before/after `docker restart` and after removing/recreating the container against the same volume: identical SHA-256 in all three snapshots (`cd6d57d614f01db1eca346c124cab7647bfe7d9df166d5c8abae1f6021052dad` for this synthetic run).
- Incompatible runtime: added a synthetic unexpected table while the app was stopped. New process exited with `SQLITE_SCHEMA_MISMATCH`; offline before/after row digests matched. An earlier experiment showed Next 14 can continue serving after a rejected instrumentation hook; startup now explicitly exits on mandatory bootstrap failure. The final container rehearsal verified that behavior.
- Runtime rehearsal publishes **no host ports**, refuses preexisting resources with its reserved test names, and removes only its own container/volume in cleanup. The test Compose has no app dependency and never starts the useful monolith. Build/test images may remain cached.
- Compose configuration and whitespace checks passed. The embedded `SCHEMA_SQL` body is byte-for-byte unchanged from main; only its comments changed, so existing exporter fixtures retain their source SQL. Importer and extracted-service suites were not repeated for this monolith-only behavior change.

## Limits

The comparison is deliberately exact, not an automatic migration engine. Older/altered SQLite schemas require reviewed additive migrations and backups. Neither a marker nor a successful boot proves consistency of historical domain data. The inherited test-fixture SQL remains destructive when explicitly used outside normal startup; do not execute it against useful data.

Persistent volumes do not transfer data out of a previous unmounted container and do not replace backups. Full-stack cutover, live B/C/D wiring, durable activation and wallet provisioning, actual broker/saga recovery, Pact and combined 8 GB measurements remain separate work. This test does not claim those pass.
