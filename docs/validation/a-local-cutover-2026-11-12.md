# Actual local cutover — 12 November 2026

This records the explicitly authorized local deployment, following merged PR76/77.
Application images use merged main `24d2171`; this patch changes only the read-only
checker, its regression and documentation. It does not activate another environment.

Observed results:

- Original SQLite source backed up, frozen and compared with the pinned snapshot.
  A separately prepared Booking copy preserves the original records and archives
  nine already processed legacy events without replaying them.
- Both PostgreSQL owners imported; Booking checkpoint reconciled and approved
  through the real Keycloak-authorized operator CLI and signed deployment receipt.
  This historical terminal dataset has zero eligible open legacy gateway bindings;
  this run therefore does not exercise a nonempty legacy-binding financial flow.
- PostgreSQL owner backups and Keycloak backup restored into new databases;
  every table fingerprint matched. SQLite and identity/session sidecar restore passed.
- All16 containers running, configured health checks passing, trusted macOS HTTPS
  readiness200. Separate runtime database identities have business DML privileges;
  owner/schema/binding writes remain offline.
- Nine actual PKCE logins with explicit subject/role/domain-ID mapping passed.
  Four provider wallets, four customer transaction histories, nine inboxes and
  four owned Booking detail reads matched migrated data. Missing credentials and
  wrong-role reads were denied. No business mutations were performed by this smoke.
- Nine persisted sessions survived a controlled restart of Booking and both APIs;
  the test sessions were then logged out. Readiness recovered.
- Before traffic, complete signed-checkpoint reconciliation passed. After startup,
  the live report-mode checker observed zero violations, attention or pending items.
  Sequential live snapshots are monitoring evidence, not a replacement for the
  original externally frozen approval.

## Checker correction

The checker previously rejected slot holds for both cancelled and completed orders.
Booking completion retains booked occupancy in the inherited and current flow;
confirmed cancellation releases it. The checker now rejects only cancelled holds,
retaining the existing finding ID. No source rows were removed to obtain a pass.

`bash scripts/run-consistency-check-tests.sh`:12 tests passed, zero failures/skips,
with real disposable SQLite/PostgreSQL/RabbitMQ. The added regression keeps a hold
on a completed booking with a future service date and verifies unchanged database
hash/mtime. The existing cancelled-hold negative case still fails as expected.
Hosted CI remains separate until this patch has run there.

## Operational boundaries

Actual deployment config, signed receipt, backups, credentials and raw evidence
remain ignored local files. The signing private key is not mounted into runtime.
The retired original source is read-only; runtime uses the prepared Booking copy
and the two PostgreSQL owners. Do not restore an old source after new financial
or broker effects. Use the private deployment wrapper for this persistent stack;
ordinary default Compose commands are not its deployment configuration.

Tracked deployment gates remain false by default. This local acceptance does not
close browser visual QA, the final dossier, additional extraction decisions or all
team work. It makes no new load/peak-memory claim and does not replace E's existing
separate resource-budget evidence.
