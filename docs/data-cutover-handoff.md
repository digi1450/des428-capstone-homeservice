# Offline data migration and caller cutover preparation — A → B/C/D/E

Status: prepared tooling and integration plan, NOT an executed migration or live cutover. Existing monolith source, schemas, boot behavior and application Compose files remain unchanged. [Caller inventory](extraction-inventory.md), [Payments handoff](payments-business-handoff.md), [notification mappings](notification-mappings-handoff.md), [nginx handoff](nginx-handoff.md) and [validation](validation/data-migration-2026-11-06.md) apply together.

## Prepared tools and boundaries

`tools/data-migration/export_snapshot.py` opens a provided SQLite database read-only in one transaction. It never imports the app/bootstrap. It exports two private JSON bundles with one snapshot UUID/event watermark: Notifications receives only notifications; Payments receives intents, ledger, wallets and webhook receipts. No passwords, identity profiles, OTPs, addresses or Booking tables are exported. This is an offline administrative snapshot, not permission for services to query another database at runtime.

The original intent lacks customer/provider identifiers: export enriches it from the same SQLite snapshot's authoritative order, adding THB. Completion ledger rows get `context_json` from the stored order total/commission/owners/method so the new completion primitive can recognize a replay without crediting twice. Public IDs, references, amounts, statuses, recipient/read state and timestamps are retained. Wallet balances are copied, not recalculated or reset.

Export checks source integrity/foreign keys, recipients, financial context, duplicate booking/kind effects, completion arithmetic, wallet/ledger reconciliation and pending legacy events/webhooks. It rejects inconsistent data rather than merging/deleting history or pretending an unpaid intent settled. The inherited seed starts wallets at zero and has no withdrawals/opening-balance model; if actual data has externally adjusted balances, stop for an explicit reconciliation/migration extension. Missing/nullable financial ownership/order facts also require reconciliation, not guessed owners.

`import-snapshot.mjs` validates complete table/column ownership, bounded integer values, UTC millisecond timestamps (rejects invalid dates/submillisecond loss), uniqueness, receipt/intent/charge/refund relationships and wallet totals before SQL. It imports through ONE owning service database/credential. `import-cli.mjs` defaults to a rollback-only dry-run; `--apply` explicitly commits that service's transaction. Driver errors, rows and database URLs are not printed. Reports contain snapshot UUID, normalized-row digest, table counts, mode and action; protect even these audit reports.

Only an entirely empty target or an exact full-row replay is accepted. Mixed/partial/different targets are rejected; there is no truncate, upsert/overwrite, delta-sync or auto-repair mode. Service tables are exclusively locked for import/verification. All row inserts and sequence adjustments run in one serializable transaction per service. Identity counters advance beyond imported IDs without lowering a counter already ahead; transactional `ALTER ... RESTART` allows dry-run/failure rollback of counters as well as rows. There is NO atomic transaction across the two PostgreSQL databases. If one applies and the other fails, keep the system stopped, inspect the failure and resume safely with the same bundles; do not open traffic halfway through.

Current tool compatibility is deliberately pinned to Notifications `001_initial.sql` and Payments `001_initial.sql` + `002_ledger_invariants.sql`. Additional B/C schema migrations trigger `SCHEMA_REVIEW_REQUIRED`. A/C must update the tool/tests after reviewing command/fence/eligibility/dedupe/outbox bootstrapping; these scripts do not fabricate that missing metadata. This is a required integration revisit, not a claim that importing business rows alone finishes C's consistency model.

The tools load snapshots into memory and insert parameterized rows individually. Performance/large-dataset limits and the complete stack's 8 GB budget are not measured. Service query/lock timeouts remain active; on timeout investigate and rerun while stopped, do not remove safety checks or enable writers. IDs/cents must fit the conservative supported integer range; exhausted identities or incompatible historical values stop migration.

## Future execution runbook — not performed by this PR

1. **Prepare runtime first.** B auth/token→integer identity mapping, C metadata/recovery/bootstrap and all caller/writer changes below must be reviewed. E must provide durable volumes and a non-destructive monolith startup before cutover. The current monolith startup applies DROP/reseed: restarting it after import can destroy Booking/identity continuity. Do not start that original bootstrap against preserved data or use its reset command during migration.
2. Arrange an offline window. Block every user/background writer, stop new booking/payment requests, recovery workers, webhook/simulation ingress and provider registration/approval. Drain and reconcile the old notification relay before stopping it. Stop all legacy/new consumers after draining. A read-only SQLite connection cannot prove other processes are stopped; `--writers-stopped` is an operator attestation, not a lock/freeze mechanism.
3. Back up SQLite **consistently**, including committed WAL state via SQLite's backup API or a correctly closed database; do not copy only a live `.db` file and omit its WAL. Preserve identity/Booking data, original idempotency responses and the source snapshot for rollback/audit. The export tool does not acquire the container backup or stop any process. E/A must verify the real mounted `DB_PATH` first; default runtime is `/app/data/edemand.db` and the inherited Compose has no persistent volume. Use a private, ignored `output/migration/` directory with restricted access. Keep the original backup immutable.
4. Reconcile pending/broken data. Export rejects any `events.processed_at IS NULL` and unfinished webhook receipt. The inherited relay stamps processed_at before dispatch: an empty pending queue does NOT prove past delivery. Check the expected effects/ratings against source history and resolve mismatches. Never stamp events processed just to pass export. The exporter records max legacy event ID; it does not migrate/replay event history or certify dispatch success.
5. Export a frozen, accessible SQLite copy. Example from repo root (placeholder source path):

   ```sh
   python3 tools/data-migration/export_snapshot.py \
     --source output/migration/frozen-source.sqlite \
     --output output/migration/snapshot-1 --writers-stopped
   ```

   Output directory must not exist. Bundles are written via a private temporary directory then published together; directory mode 0700/files 0600. Keep bundles/audit reports untracked; they can contain private notification text and financial history. Do not attach them to PRs or chat. Export does not modify source rows or mark events processed.
6. Install each service's existing dependencies (`npm ci --prefix services/notifications`, `npm ci --prefix services/payments-wallet`) if needed, and apply its reviewed schema migrations to its own stopped/empty target. Use the appropriate offline database-owner credential through `DATABASE_URL` in the shell; do not put real URLs/passwords into a committed command/file or logs. The runtime account may later lack the sequence/table privileges required for offline administration.
7. Dry-run **BOTH** owners with their respective credentials before applying either. Ensure both reports show the same snapshot UUID and expected table counts, and review the normalized-row digests:

   ```sh
   # Set DATABASE_URL securely to Notifications' database before this command.
   node tools/data-migration/import-cli.mjs notifications output/migration/snapshot-1/notifications.json
   # Set DATABASE_URL securely to Payments' database before this command.
   node tools/data-migration/import-cli.mjs payments-wallet output/migration/snapshot-1/payments-wallet.json
   ```

   Dry-run performs actual inserts/full-row verification then rolls back, including sequence changes. It needs the same offline/lock privileges as apply. Do not point it at an active database.
8. With writers still stopped, run each command again with `--apply`, switching to its own credential each time. Save both successful reports privately. Re-running the exact snapshot against an identical target is accepted; changed rows/new live writes cause rejection. Reconcile C's approved metadata bootstrap using the same frozen Booking facts before admitting traffic.
9. Enable the reviewed caller/writer changes and C producer/consumer configuration **together**, then E selects nginx candidate mode. Retire old notification delivery/direct writers, financial SQLite access and old wallet signup writes. Keep Catalog/Provider rating updates with monolith owners. C defines the legacy event-watermark boundary/new event IDs so historical events are not replayed as fresh effects; A's exporter does not seed C dedupe or command IDs. Existing final HTTP idempotency results/old booking intents need an explicit C compatibility/recovery plan; do not reinterpret them as new create commands.
10. Run the acceptance cases below with real B/C/D/E implementations, then reopen writes. If anything fails before opening writes, keep services stopped and restore all affected data/caller/config state coherently or roll forward. After accepting new writes, reverting only nginx to stale SQLite is unsafe: use a reviewed data-aware recovery plan. Do not delete the source backup or migrated tables as part of this preparation.

## Caller changes still required when dependencies arrive

Paths below are relative to `bangkok-homeservice/`. This matrix was refreshed by source search; these callers still use the old path today. The new service clients/adapters are prepared, not wired. Change whole read/write flows, never only a dashboard reader.

| Flow / current file(s) | A's change and dependency | Acceptance evidence after integration |
|---|---|---|
| `app/api/notifications/route.js`, `app/api/notifications/[id]/read/route.js`, `app/notifications/page.js` | Async authorized Notifications client for monolith/Server Component reads, correct B domain-ID mapping and token forwarding; candidate nginx routes public API directly | Old IDs, ordering, unread/read timestamps preserved; owner/other-role/expired token checks; HTML inbox still works |
| `lib/modules/notifications/relay.js`, `lib/modules/providers/service.js`, `instrumentation.js` | C durable event producers/consumers call prepared mappings/writer; approval currently writes directly, so it needs the reviewed approval event. Retire legacy delivery, preserve ratings in monolith and stop destructive bootstrap | No lost/duplicate delivery across legacy boundary; each inherited event and approval; ratings still change exactly once |
| `lib/modules/booking/service.js` placement/detail | Use prepared Payments/Booking adapter after C durable key/context/saga wrappers; never hold SQLite transaction across HTTP | Gateway booking returns compatible 201/order/OTP/intent; COD makes no intent; detail retains old intent ID; unknown result retains slots and command ID |
| Same file: completion/cancellation | C orchestrates local Booking steps and Payments completion/refund/void through authorized service operations with durable reconciliation | Migrated gateway and COD completions do not double-credit; refund preserves history; confirmed failure vs timeout/compensation and restart cases |
| `lib/modules/identity/service.js`, `lib/modules/identity/repository.js` | Replace direct wallet creation with C-coordinated recoverable/idempotent provisionWallet flow; agree durable registration behavior before implementing | Existing and new providers have one correct wallet; retries/restart do not create partial/unrecoverable registration |
| `app/api/provider/wallet/route.js`, `app/api/customer/transactions/route.js`, `app/(provider)/provider/wallet/page.js`, `app/(provider)/provider/dashboard/page.js` | Async Payments client with B verified identity, including Server Component credentials; preserve projections; candidate gateway handles public API | Matching migrated balances/history, ISO dates and owner scoping through both HTTP and rendered pages |
| `lib/modules/payments/gateway.js`, `app/api/payments/simulate/route.js`, `app/api/payments/webhook/route.js`, `app/_ui/client.js` | Expose real authorized Payments mutations only with C eligibility/outbox/dedupe; D safe retry and stable browser request key; retire old SQLite settlement | Simulation/webhook replay does not charge twice, compensated bookings cannot settle, UI pending/retry path resumes the original operation |
| `lib/db/schema.js`, `lib/db/seed.js`, inherited fixtures/tests and old repositories | Replace production reset/seed behavior, keep explicit disposable demo/test seed, remove all runtime access to moved tables only after full cutover | Repeated startup preserves Booking/identity/financial IDs; original behavior tests stay meaningful; source search finds no active cross-owner SQL |

After the changes, rerun the inventory search over APIs, modules, Server Components and bootstrap, not only gateway routes. B/C must supply actual interfaces/credentials; no fake role header, SQLite fallback or invented command store is an acceptable integration substitute.

## Reproduce preparation tests now

With Python 3, Docker and each service's existing `node_modules` installed, from repo root:

```sh
sh tools/data-migration/run-tests.sh
```

The test runner builds a synthetic SQLite file from the actual original schema (without running its app), exports it, then uses two isolated PostgreSQL 16 containers and Node 22 to verify imports and existing service business primitives. No host ports, real users/tokens, production DBs or persistent volumes. It tears down only `homeservice-migration-test` and deletes its own temporary fixture directory; do not run concurrent copies or use that project name for real data. Passing this proves the prepared offline mechanism for covered data, not a live distributed cutover.
