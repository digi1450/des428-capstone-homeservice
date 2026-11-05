# Offline data/caller preparation — 6 November 2026

Base: `1198cd3351b9a8d2fd496467247e8c53ac2a7c71` (nginx PR #10 merged). Scope: offline snapshot tools, synthetic SQLite→two PostgreSQL rehearsal and caller cutover handoff. No real data migration, caller change or active cutover.

## Executed validation

```sh
sh tools/data-migration/run-tests.sh
sh -n tools/data-migration/run-tests.sh
git diff --check
```

Final runner exited 0:

- Python unittest: **8 passed**. Source created from the actual monolith `SCHEMA_SQL`, without importing/running its bootstrap. Tests cover private paired export, unchanged source hash/no credential export, explicit writer-stop attestation/no overwrite, pending event/webhook refusal, duplicate financial effects, wallet mismatch, missing recipient and wrong completion amounts. The output's same snapshot UUID/watermark and private file modes were checked.
- Node test runner in `node:22-slim`: **21 passed, 0 failed/skipped** (includes its nested test groups), with **two separate real PostgreSQL 16 containers**. Validators reject wrong service/table/columns/ID range, invalid/submillisecond dates, duplicate effects, inconsistent completion/wallet/receipt/charge state. Both owners reject future schema additions before writes; CLI defaults to dry-run and sanitizes failure output.
- Real inserts were exercised in rollback-only dry-run: tables remained empty and sequence `last_value/is_called` unchanged afterward. Apply/replay preserved all rows; different nonempty targets were rejected. Injecting a failure before the second insert rolled back the first insert and left sequences unchanged. Replay preserved a previously advanced identity value. New Notifications, intent, transaction and receipt IDs exceeded imported maxima.
- Existing Payments business functions were run against imported rows: gateway AND COD completion replay returned historical transaction IDs without another wallet change; refund replay returned historical refund ID; customer history/intent lookup retained IDs/statuses; old webhook replay remained deduped without a new charge/outbox callback. These are actual business primitives, not mounted HTTP mutations or C's production eligibility/outbox implementation.
- Fixtures include gateway completed/charged, gateway refunded/cancelled, COD completed and unpaid gateway bookings; read/unread notifications and processed webhook receipts. Fixtures contain no real users, auth credentials or money. The source file is synthetic; the running original monolith was not stopped, restarted or reseeded.
- Runner removed its fixture containers/network and temporary source/export files. No host ports or persistent volumes. Other Docker projects were left running.
- SHA-256 check against the baseline manifest found **all 135 original files unchanged**. Documentation links, shell/JS/Python syntax and whitespace were checked. Only documentation/tools are changed; existing application code, service migrations and application Compose files are untouched.

An initial integration test failed because the test called Notifications.record with storage snake_case instead of its documented camelCase input; corrected the fixture call, not application behavior. A driver warning also revealed concurrent queries queued on one SQL client; importer now reads tables sequentially. Final run above has no failures or those warnings. Counts above describe the final run, not repeated runs summed together.

## Remaining limits and integration revisit

No real source backup was acquired or imported. Writer-stop is an operator attestation and pending-queue checks do not prove reliable legacy delivery; the old relay stamps processed_at before dispatch. Cross-owner imports are separate transactions, not atomic together. Tools support the current A schemas only; C schema/state bootstrap must be reviewed before extending compatibility. No historical command IDs/dedupe records are invented.

API/page/Booking/relay/signup callers remain on SQLite. Real B auth, C saga/recovery/outbox/dedupe, D fault/concurrency checks and E full-stack/Pact/OTel/resource checks are pending. The existing monolith startup still DROP/reseeds, so durable/non-destructive runtime setup is a cutover prerequisite. This slice does not prove a live migration, UI behavior or the full-stack 8 GB budget. Existing application suites were not rerun because no application code changed; the new tests exercise the relevant unchanged business primitives directly on imported PostgreSQL data.

See [data/caller handoff](../data-cutover-handoff.md) for offline execution, paired preflight/apply, dependency matrix, acceptance and data-aware rollback limits.
