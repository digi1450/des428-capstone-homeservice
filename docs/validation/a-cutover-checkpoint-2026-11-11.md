# A step2 operator/checkpoint validation — 11 November2026

Branch: `feat/a-cutover-checkpoint`, based on merged main `a1fa7d5` (PR75).
These are observed local runs, not hosted-CI approval or useful-data cutover.

| Observed check | Result | Scope |
| --- | --- | --- |
| Monolith full suite after deployment/local-checkpoint guard |303 passed|Includes existing Booking/caller/startup behavior; isolated data|
| Financial + legacy eligibility PG tests |21 passed|Actual disposable PG16 owner|
| Operator JWT/Ed25519 tests |2 passed|Synthetic RSA issuer/JWKS; signature/audience/client/roles/expiry and receipt tampering|
| Migration suite |28 Python +44 PG passed|Includes historical receipt compatibility and strict failures; actual isolated PG owners|
| Portable signed checkpoint rehearsal |7 passed|Node22, two PG16 owners, RabbitMQ4.1; actual management unacked counters, partial apply, interruption/replay, full-source checker, revoke/refusal|
| Backup restore |passed|Actual custom-format pg_dump/pg_restore into NEW pre-import empty targets; source SQLite restored into a NEW file|
| Standalone C checker |11 passed|Actual SQLite/PG/RabbitMQ image; existing CLI preserved|
| Legacy HTTP/new-process recovery integration |1 passed|Actual HTTP/PG boundary with fixture auth; original keys, once-only ledger and held slots|
| Actual authenticated final stack |passed,16 services|Fresh disposable project `homeservice-e-auth-cutover-operator`; real Keycloak operator tokens, Booking-token rejection, selected flow traces, SIGKILL/redelivery, pending cancellation/recovery and worker broker recovery|
| Optional receipt Compose overlay |parsed and inspected|Explicit non-creating Booking bind replaces named volume; receipt/public key only. Configuration-only, not actual useful-data deployment|

The final-stack run used `FINAL_STACK_TELEMETRY=true` and
`FINAL_STACK_FAULTS=true`. It is not a graphical-browser or8GB peak/load test.
The receipt overlay is an additional opt-in file; that overlay itself was not
used to activate a useful historical database in the16-service run.

## Selected local source: a real blocker was detected

A private DB+WAL copy was hash-checked stable during copying, consolidated on
the private copy, then exported. Aggregate counts were customers4, providers4,
orders2, intents1, notifications11. No source records were changed. The source
ZIP was unavailable at its previous path, so exact identity with the original
instructor ZIP is unverified. Copy/export is not an attestation of final freeze.

The instructor-era receipt `payment.succeeded` initially failed PG validation.
The offline importer now preserves this known historical type only when its
payload/event ID match, it is processed, and a succeeded intent/charge match
its reference. No receipt is rewritten. Unknown/unprocessed historical formats
fail; public callback validation remains `payment_intent.succeeded`.

With that correction, dry-run/apply/replay of both owners succeeded on the
private source copy. Booking preparation then correctly failed with
`SQLITE_SCHEMA_MISMATCH`: the source has36 objects, the current schema adds14
objects and broker columns on `events`. It contains9 processed historical
events. No fingerprint bypass, reset, synthetic old event IDs or fabricated
published markers was applied. All rehearsal targets were disposable and
removed. This source is **NOT READY for actual cutover**.

Next source-specific work must define and test an exact-schema offline upgrade
that preserves old audit/history and its watermark while preventing old events
from being republished as fresh effects. Reconcile owner rows and identities,
restore matching sidecars/configuration and repeat source-specific deployment
acceptance before requesting the final operator go/no-go. The checkpoint
preparation in this PR does not close that source-upgrade gate.
