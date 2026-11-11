# SQLite startup and persistence

A startup change, 7 November 2026. This preserves the monolith's existing SQLite ownership; it does not move Booking/identity to PostgreSQL or activate extracted-service traffic.

## Normal startup

`instrumentation.js` calls `bootstrapDb()` before starting relays. `migrate.js` takes an immediate SQLite transaction: an empty database receives the current CREATE schema, seed data and a schema fingerprint atomically. Later boots validate the actual table/index/trigger/view definitions and fingerprint and leave rows and sequences unchanged. The current legacy schema without a marker is adopted without reseeding, changing event identities or replaying messages. A failed initialization rolls back its schema, seed and marker together.

The schema comparison is deliberately conservative, including stored SQL text. Partial, older or manually altered schemas (even an extra table/index or equivalent differently written DDL), and missing/invalid version records fail with `SQLITE_SCHEMA_MISMATCH`. There is no automatic upgrade for them. Stop the app, take a consistent backup, inspect differences and implement/test a specific additive migration before deployment. Future C schema additions require that work too; never remove the marker or delete tables to evade a mismatch.

`SCHEMA_SQL` retains the original reset SQL for isolated test fixtures/exporter compatibility. Normal migration strips its known DROP statements and never executes them. `bootstrapDb({reset:true})` is allowed only with `NODE_ENV=test` AND an actual `:memory:` connection. The inherited `freshBoot()` helper requests this explicitly. File databases cannot be reset through that API, even with `NODE_ENV=test`.

## Containers and operational limits

Both root and monolith Compose mount `monolith-data:/app/data` in their own Compose project. Restart, `down` (without `-v`) and container recreation retain the named volume. Volumes are not backups: make consistent SQLite backups including committed WAL state before schema changes/cutover. Do not run an old destructive application image against the volume.

Adding a volume cannot recover data already deleted by an older boot. Before replacing an old container that did not have a volume, stop writers, back up its actual SQLite database consistently, and restore that backup into the intended volume with appropriate ownership. Starting the new empty volume without restoration creates a new seeded demo instead of transferring the old container data.

For a fresh disposable demo, use a NEW dedicated Compose project/volume and choose a free host port (or use root `GATEWAY_PORT`); retain useful old volumes. There is no normal file-reset command/environment flag. Do not use `down -v` as an update procedure. In-memory tests remain disposable and isolated.

Durability here means the bootstrap does not erase stored work. It does not prove end-to-end saga recovery, broker replay, Payments activation, B auth, a completed data migration or the full stack's 8 GB budget. Startup failure occurs before relay startup. Other background workers retain their existing behavior after a successful boot.

Validation: [isolated startup/restart checks](validation/sqlite-startup-2026-11-07.md).

## PR65 CI follow-up: concurrent first WAL open

GitHub run43009904347 failed in startup.test.js when two real processes attempted
journal_mode=WAL concurrently, returning SQLITE_BUSY before migration. The importer
workflow43009904490 passed. getDb now retries only WAL initialization SQLITE_BUSY
with a bounded3s budget, then restores the existing3s busy timeout and enables FKs.
Any other error/expired wait closes the uncached connection and propagates failure.
No schema/reset/bootstrap/seeding rules changed.

A real separate-process held-lock regression checks waiting/data preservation.
A deterministic immediate-BUSY fixture fails on the old initializer; the new
initializer recovers it and closes/propagates a non-BUSY error. Final local Linux
Node20 full monolith300/300 passed, zero failures/skips. Early container attempts
lacked test-helper/API/contract/realm mounts; final run includes all source fixtures.
GitHub Node22 checks for the new head must still complete; no hosted pass implied.
