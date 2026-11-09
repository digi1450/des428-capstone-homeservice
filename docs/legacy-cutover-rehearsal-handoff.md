# A step 5D — legacy rehearsal and source boundary

9 November 2026, based on main `4870ee8` (#45). This slice prepares and tests the
**legacy-only** offline data path. It does not decide legacy provisioning adoption,
complete step 5D, activate financial ownership or migrate useful data.

Read the [data runbook](data-cutover-handoff.md), [financial v1 contract](financial-finalization-contract-handoff.md)
and [runtime handoff](financial-finalization-runtime-handoff.md) together. Importing
historical rows and permitting future business operations are separate gates.

## Source guard: never mistake mixed ownership for a legacy snapshot

The old exporter rejected pending legacy events but could accept a SQLite source
with C saga/inbox/broker history. Such a file may have an order whose intent,
ledger, command or delivery state exists **only** in a service/broker. Copying its
SQLite financial tables alone is not a distributed checkpoint.

The read-only exporter now checks these known C markers inside its same SQLite
read transaction, before publishing any bundle:

| Marker | Result |
|---|---|
| Any row in booking_sagas, booking_saga_transitions, booking_saga_activations or processed_events | SOURCE_DISTRIBUTED_STATE_REQUIRES_REVIEW |
| Any event published_at, publish lock/error, or publish_attempts > 0 | SOURCE_DISTRIBUTED_STATE_REQUIRES_REVIEW; an unknown publish outcome is not evidence nothing reached RabbitMQ. |
| Unresolved consistency_attention | SOURCE_UNRESOLVED_ATTENTION |
| No C tables/publish columns in a pre-broker original source | Still supported; existing integrity/ownership/ledger/pending-event checks apply. |

Terminal COMPLETED/CANCELLED saga history is also a mixed-source marker; it is not
permission to discard owning-service state. Resolved attention records remain in
the retained source, not copied into the two financial/inbox bundles. There is
no force flag, clearing/dropping state, invented fence or auto-resolving attention.

This is a guard for **known** source metadata, not certification of every future
schema or proof that writers are stopped. Re-review new C financial-work tables
and all owning schemas before exporting a later source. External queues can hold
messages even if these local markers are absent. Existing operator freeze/drain,
backup, watermark and C/E queue handover requirements remain mandatory.

If rejected, keep the source and useful services unchanged. Inventory the actual
Booking SQLite, both owning PG databases and broker/checkpoint together; C/A/E
must define a separate reviewed mixed-state procedure. Do not delete metadata,
stamp events delivered or replay bookings as new commands to make this exporter
pass. The original source and stable HTTP idempotency responses stay preserved.

## Synthetic legacy acceptance matrix

`tools/data-migration/test_export.py:make_source` uses the current monolith schema,
fake identities and eight representative orders. These fixture IDs are test data,
not production order IDs or new domain identifiers.

| Fixture | Preserved historical facts | Remaining future-operation gate |
|---|---|---|
| 10: gateway completed/paid | Intent 40, one charge, payout 110; wallet includes 850. Existing completion primitive replays without crediting again. | New financial command/work compatibility and legacy binding; never pay twice. |
| 11: gateway cancelled/refunded | Intent 42 remains succeeded historical settlement; charge and refund 121 retained. Refund primitive replays unchanged. | Preserve terminal Booking, prevent late event revival; no new payout/refund. |
| 12: COD completed | No intent; commission 130 retained, commission owed 450. | Existing accounting replay vs new durable-work identity; no fabricated gateway saga. |
| 13: gateway awaiting/unpaid | Intent 45 requires_payment; original reference/amount/owners preserved. | Current actual C create/activate cannot adopt it; new callback is rejected. Legacy eligibility/binding is required. |
| 14: gateway confirmed/paid | Intent 46, charge 140, processed gateway receipt; no payout yet. | Completion/cancel needs reviewed legacy binding/work. A new gateway event acknowledges already-settled, creates only its receipt and no second charge/outbox. |
| 15: COD confirmed/open | Booking remains in retained SQLite, no intent/ledger fabricated. | C durable completion/cancel work and B auth; COD must remain intent-free. |
| 16: gateway cancelled/unpaid | Intent 47 failed, no charge or refund invented. | Current callback rejects; do not invent cancellation/provisioning keys or reactivate it. |
| 17: COD cancelled | Terminal Booking retained; no financial effect invented. | Preserve terminal behavior and replay identity; no future commission from cancellation. |

Both services retain their own schemas/credentials. The importer still imports
only the owning business tables, with empty C command/provisioning/outbox/dedupe
state; it does not copy Booking/identity data into PG or synthesize C eligibility.
Unknown target migrations still fail SCHEMA_REVIEW_REQUIRED, and any existing C
state fails MESSAGE_STATE_NOT_EMPTY for fresh import or identical replay.

## Rehearsal performed with actual components

Run from repo root with Docker, Python 3 and installed locked service dependencies:

```sh
sh tools/data-migration/run-tests.sh
```

Observed locally: **16 Python tests passed** and **34 Node/PostgreSQL tests
passed**, with no failures/skips. The Python suite was rerun after adding the WAL
case; the unchanged Node/PG rehearsal had already passed with all eight cohorts.

The runner generates a synthetic SQLite file, exports through the actual
read-only tool, runs both actual owning migrations/importers against dedicated
PostgreSQL 16 tmpfs containers and deletes only its own resources. It exposes no
host port and never starts the original application or touches useful data.
The new CI workflow runs this same command, not a parallel mock implementation.

- Python source/export tests cover original private export/invariants, eight
  cohorts, rejection without source mutation/output publication, pre-C schema
  compatibility, and a real SQLite WAL backup example. With a committed row still
  in WAL, a main-file-only copy misses it; SQLite backup API preserves it and the
  exporter includes it. This fixture is not a backup of the user's database.
- Node/PG tests cover both dry-runs, apply, identical replay, changed-target and
  unknown-schema rejection, transaction/sequence rollback and real lock ordering.
  Existing business wallet/history/ID/accounting/refund replay checks remain.
- New HTTP boundary uses actual `createPaymentsRuntime`, C provisioning participant,
  settlement eligibility and outbox hooks against the imported PG data. Only auth
  verification is a labeled fixture; no C financial participant stub is installed.
- Synthetic create/activate attempts for each imported gateway intent return 409,
  unknown command lookup stays 404, and unpaid/voided callbacks are rejected. All
  imported business rows and C tables remain identical. Probe keys are deliberately
  rejected test inputs, not proposed historical identities or adoption logic.
- Existing gateway receipts replay without effects through the actual runtime.
  The already-paid fixture's different event ID stores one additional receipt and
  returns already_settled; repeated delivery stays deduped, with one charge and no
  new outbox/accounting effect. Only that test-owned receipt is removed afterward.
- PostgreSQL identity allocation can consume numbers on rollback. A harmless gap
  is not a committed financial effect and must not be repaired by lowering a live
  counter. Relevant row/effect invariants and next-ID safety are checked instead.

No real Keycloak, new C durable financial command/work/recovery, broker queue
handover, financial race/restart or final UI/routing/cutover success is claimed.
Existing direct business primitive replay tests are not new financial protocol
acceptance. No application runtime code, schema, dependency or route was changed.

## What remains before a real cutover

1. **A/C legacy model:** define an auditable legacy binding/eligibility mechanism
   for old open gateway bookings, settled orders and terminal history; version the
   contract/schema if needed. Current v1 gateway requests require saved reviewed
   provisioning references. Do not fill that gap with generated old command IDs.
2. **C/B implementation:** actual durable financial operations/Booking work/guards/
   recovery plus verified user/service/mock-gateway auth and delegation. Then A
   wires the prepared callers and validates whole financial flows.
3. **A/C schema review:** update the importer's exact target migration allow-list
   only after reviewing new C schemas; preserve SQLite's exact startup guard.
4. **A/C/E checkpoint:** agree legacy event watermark, queued/in-flight messages,
   stable request replays, new owner processes and seed/wallet state. A SQLite-only
   export is intentionally unavailable for a known mixed-state source.
5. **A/D/E rehearsal:** freeze and consistent backup, both owner dry-runs, apply,
   row/ID/balance/receipt reconciliation, real auth/API/HTML/fault/restart evidence
   and data-aware rollback. Keep ingress/writers stopped if only one owner import
   applies; service-local transactions do not make two PG imports atomic.
6. **Final switch:** only after all gates pass, select remote readers/writers/
   consumers and reviewed nginx routing together. After new writes, reverting
   nginx alone to stale SQLite is unsafe. This change enables none of those modes.
