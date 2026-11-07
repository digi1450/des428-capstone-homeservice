# A review of C importer compatibility — 7 November 2026

Base: main `7e2f91acaeaae1570ad1009ae4a82aa676e91d7a`. Scope: review C's importer pin update for Notifications `002_processed_events.sql` and Payments `003_outbox.sql`. Neither migration alters imported business columns. The exporter fixture's explicit legacy events column list is compatible with C's added columns.

## Finding and fix

The pin update allowed the new schemas but its comment assumed outbox/dedupe tables stayed empty. Import only checked business rows: it accepted a fresh import or exact replay even if `processed_events`/`outbox_events` contained data. No message rows were deleted, but the tool could accept a target outside its agreed fresh/offline-state precondition.

Now lock business AND messaging tables before the first snapshot-taking SELECT; require C tables to be empty with `MESSAGE_STATE_NOT_EMPTY` before any business insert or sequence alteration. Preserve existing message rows on rejection. This is enforced for both dry-run/apply and exact business replays. Version pins retain both reviewed C migrations; unknown later migrations remain rejected. No runtime service, schema, C consumer/relay or actual database content was changed.

## Executed tests

`sh tools/data-migration/run-tests.sh` uses a synthetic SQLite source from the actual current monolith schema, two disposable PostgreSQL 16 tmpfs databases and Node 22. The runner does not start the monolith or expose host ports.

- Baseline before changes: Python **8 passed**, Node/PostgreSQL **21 passed**.
- Added regressions before the fix: expected rejection was missing in fresh-import and exact-replay scenarios for BOTH owners (4 failing child cases; the runner also reports their 2 failed parent groups). This reproduced the real gap without modifying service behavior to create it.
- Final run after fix: Python **8 passed**, Node/PostgreSQL **27 passed**, **0 failed/skipped**. Repeated runs are not added together.
- Both dry-run/apply reject existing message state without changing business rows or sequence state. Full message rows remain identical. An exact business replay also rejects once message state exists.
- Held an INSERT transaction open on each owner's message table, started import and observed its waiting AccessExclusiveLock via `pg_locks`. Committed the writer, then verified import saw the newly committed message and rejected BEFORE inserting any business row. This checks lock/snapshot ordering with real PostgreSQL, not a timing-only stub.
- Fresh import/replay with empty C tables leaves those tables empty and preserves existing row/ID/balance/receipt/replay checks. Unknown migration, partial-write rollback and sequence continuity tests remain passing.
- Changed JavaScript syntax, documentation links and whitespace checked. Full application and messaging/broker suites were not rerun: this patch changes only offline importer checks/tests and handoff evidence, not their runtime code.

The runner removed only its `homeservice-migration-test` containers/network and temporary fixture files; unrelated projects and useful databases were not stopped/reset. Dependency installs refreshed ignored node_modules to current lockfiles, with no manifest/lock changes.

## Boundaries still required

This approves current schema compatibility WITH the new empty-state precondition, not real cutover. Operators must stop all writers, relay/consumers and ingress; empty target tables do not certify RabbitMQ queue state or historical delivery. C/E still coordinate legacy watermark, queued-message handling and future command/fence/eligibility bootstrap. Do not clear existing message state to force a pass. Additional participant migrations will require another explicit compatibility review. No real backup, export/import or saga activation was performed.
