# Lead-selected legacy gateway binding baseline

10 November2026. **The team lead selected the legacy-binding approach and the
four decisions below as the implementation baseline.** This adopts C's PR60
proposal after A review. It supersedes the earlier proposal/not-agreed status;
it does not claim C/B acknowledgement or completed code, schema, migration or
cutover. The filename remains stable for existing links. AI assisted A's review
and documentation update; C authored the original proposal.

This addresses item1 of [legacy rehearsal](legacy-cutover-rehearsal-handoff.md#what-remains-before-a-real-cutover).
**Booking remains in the monolith.** This is old-data compatibility with the
already extracted Payments & Wallet service, not another service extraction.
No runtime flags, actual contracts, database schemas or useful data change here.

Exact artifact follow-up: [manifest/v1.1 handoff](legacy-manifest-contract-handoff.md)
publishes A's schema/hash/owner-row/wire fixtures. Runtime and writers remain pending.

## Selected decisions

| Decision | Implementation baseline |
|---|---|
| Binding or drain | Use audited legacy bindings for eligible old open gateway bookings. Drain is a contingency requiring a separate lead decision, not the selected default. |
| Payments write boundary | Import each binding in the SAME local Payments transaction as its imported intent/business rows. Include bindings in identical-replay comparison. |
| Gateway reference | Contract v1.1 adds `legacy_binding: { binding_id, manifest_sha256 }` alongside the existing `provisioning: { create_command_id, saga_id }`. Gateway requests require exactly one form; COD forbids both. A publishes exact wire/callable fixtures first. |
| UI | Keep `pending/ready`. Ready means financial operations are eligible, not that payment succeeded. Preserve the separate `payment_status` and cancellation/accounting states. No new `legacy` lifecycle state. |

Owners may implement within this selected direction without another policy-approval
round. A's exact versioned manifest/contract fixtures are the shared interface
prerequisite; do not invent parallel formats. Report an unsafe/incompatible detail
for coordinated revision rather than silently weakening a guard.

## Problem and permitted scope

Current gateway finalization requires saved provisioning references from a saga.
An imported legacy intent has none. Existing create/activate refuses adoption,
settlement requires activated provisioning, and legacy complete/cancel requires
reconciliation. Importing a row therefore does not authorize future operations.

A legacy binding is a reviewed, immutable link between one retained Booking order
and its imported Payments intent. Only the offline cutover procedure may create
it. Request handling, webhooks, recovery and retry must never INSERT a binding,
fabricate an old saga/create-command ID or adopt an unmatched intent.

### Initial eligibility cohorts

Numbers identify synthetic fixtures in `tools/data-migration/test_export.py`, not
hardcoded production order IDs. Classify by verified state/financial invariants.

| Fixture cohort | Binding | Selected future behavior |
|---|---|---|
|10 gateway completed/paid | none | Preserve terminal history; no new payout or completion. |
|11 gateway cancelled/refunded | none | Preserve terminal history and receipt dedupe; no revival/refund twice. |
|12 COD completed | none | Preserve terminal accounting; no new commission. |
|13 gateway awaiting/unpaid | `open_unpaid` | Existing intent may settle; completion waits for a real charge; cancellation voids/fences. |
|14 gateway confirmed/paid | `open_paid` | Completion credits once; eligible cancellation refunds once/fences; webhook replay creates no second charge. |
|15 COD confirmed/open | none | Retain the v1 COD reference-free path; prove legacy completion/cancellation in regression tests. |
|16 gateway cancelled/unpaid | none | Preserve terminal/voided state; late callbacks cannot settle. |
|17 COD cancelled | none | Preserve terminal state; no future commission. |

Unknown open gateway combinations receive no binding and require attention.
An already paid-out/refunded order, failed intent, mismatched owners/amount/currency,
contradictory ledger or existing distributed command/saga state is not made eligible
by editing metadata. Existing exporter mixed-source/attention guards still apply.

## Versioned manifest and integrity baseline — A owns exact fixtures

The current exporter emits two owner bundles with a `snapshot_id` and watermark;
it does **not** yet emit this reviewed eligibility manifest. Implement that artifact
before either binding writer. The deployed/runtime contract remains v1.0.0; target v1.1 and manifest artifacts
are now published separately in the linked handoff. Neither writer is implemented.

The v1 manifest envelope contains `manifest` (the hashed core) and
`manifest_sha256` (the full64 lowercase hexadecimal SHA256 of canonical core bytes).
The core records:

- manifest format version and the shared snapshot ID;
- the frozen, consistent SQLite BACKUP file SHA256 and its reviewed source schema
  fingerprint; these describe the immutable backup, not the later upgraded live DB;
- the legacy event watermark and per-owner bundle filename/service/SHA256 pairs,
  computed over the exact exported file bytes;
- eligible binding entries: order/intent/customer/provider IDs, amount in minor
  units, currency, eligibility and the source order/payment/intent state plus
  matching charge reference when applicable. No passwords, tokens, OTPs or profiles.

Canonical core encoding uses UTF8 without BOM or insignificant whitespace, sorted
object keys, integer numeric values only, bundle entries sorted by service and
binding entries by numeric order ID. Strings/field names are defined by A's exact
schema; no floating-point or runtime-dependent values are allowed. Hash the core,
not the envelope/hash field. Binding IDs are derived AFTER hashing:
`legacy:<full manifest_sha256>:<order_id>`; binding IDs are not inside the hashed
core, avoiding a circular hash. Both languages need shared golden-byte/hash fixtures.

A hash proves byte integrity, not operator authorization or business eligibility.
The operator must verify the approved source/checkpoint, validate hashes and
recompute classification against the frozen source and imported data. Reuse the
SAME files/manifest for retry; never generate a new manifest to disguise a partial
apply. Changed source/file/context or conflicting existing binding fails closed.
Keep manifests/backups private and outside committed evidence; publish only
sanitized test fixtures and observations.

## Payments implementation — C schema, A importer

C adds reviewed `006_legacy_payment_bindings.sql` (name reserved by this baseline,
not yet present). The table contains binding/full-manifest IDs; unique order ID;
unique intent ID referencing the owned `payment_intents`; customer/provider IDs;
nonnegative amount; THB currency; `open_unpaid/open_paid` eligibility and creation
time. C supplies constraints and A reviews compatibility before accepting006 in
the importer allow-list. Do not relax unknown-migration or empty-C-state guards.

A inserts bindings atomically with imported Payments business rows. Binding rows
are imported audited state, not invented financial commands/outbox events; exact
replay checks them along with the business rows. They do not exempt pre-existing
saga/command/fence/delivery state from the legacy-only source/target restrictions.

Settlement/finalization must enforce:

- Existing activated provisioning OR an exact legacy binding for this intent.
  Validate order/intent/owner/amount/currency and full manifest references.
- All existing cancellation/provisioning fences still win. Preserve the shared
  per-order locking and reviewed lock order for webhook/complete/cancel races.
- Create/activate continue refusing legacy intents. A binding is not a new saga.
- v1.1 completion requires a matching succeeded charge before payout. Cancellation
  voids unpaid intents or refunds an eligible charge once and always fences;
  never refund after payout. Unknown outcomes stay pending with the SAME durable
  command; contradictions go to attention. Stable caller auth is unchanged.
- Missing/mismatching references remain reconciliation/context errors. A client
  supplied hash or binding ID alone grants no authority. Exact codes/shapes are
  supplied by A's v1.1 contract fixtures before code integration.

## Booking implementation — C with A caller/schema review

Add `booking_legacy_payment_bindings(order_id PK, binding_id UNIQUE,
manifest_sha256)` through a new additive `UPGRADES` entry appended AFTER all current
steps. Do not reuse the proposal's old “step3”: E now owns
`e-event-trace-context` and `e-booking-work-trace-context`. Preserve those entries,
existing rows/context, exact schema guards and atomic rollback; do not reset DBs.

The trusted offline operator CLI reads the same approved manifest after successful
Payments import. It verifies hashes/backup identity and current Booking order
owner/amount/currency/state against the frozen entry; rejects saga/financial-work
conflicts; writes only Booking binding rows in its own local transaction. Identical
replay is allowed in the still-frozen, unchanged cutover state; a different manifest,
changed target or new distributed work requires review, never overwrite.

Snapshots use saga provisioning refs when present, otherwise the exact approved
legacy binding, otherwise today's reconciliation refusal. Both forms cannot
coexist. Keep terminal/OTP/provider/customer/slot guards unchanged. Bound open
orders may show setup `ready` only after the coordinated checkpoint below; while
unverified/half-applied, traffic remains closed and no success is claimed.

## Coordinated checkpoint, activation and rollback

Payments import, Notifications import and Booking binding writes are independent
local transactions. **They are not an atomic distributed commit.**

1. Review legacy-only eligibility, freeze all writers/relays/recovery, drain and
   disconnect consumers, establish broker/event/idempotency watermarks and take
   consistent backups of every participating owner. Mixed-state sources need their
   separate reviewed procedure; never clear C markers to force this path.
2. Review/apply compatible schemas, produce/validate the one manifest and dry-run
   both owner imports plus Booking binding validation while traffic stays closed.
3. Apply owner imports; insert Payments bindings in its import transaction, then
   run the Booking binding CLI using the same manifest. Retain sanitized operator
   completion records identifying the manifest and each owner phase.
4. Reconcile both directions: every eligible binding must match across owners,
   every referenced intent/context must match, no order may have binding AND saga,
   no fenced booking may retain unrefunded money. Extend the PR59 read-only checker
   for those invariants and its current required006 schema. Verify queues/DLQs and
   all other freeze/replay/data gates; omitted sources are not certified.
5. If ANY owner phase/check fails, keep ingress, writers/recovery/consumers closed.
   Resume an identical verified import or restore the coordinated pre-cutover
   checkpoint through the reviewed runbook. Do not delete useful binding/command
   rows or switch nginx alone to stale SQLite to “roll back”.
6. After all owner phases, auth/business/HTML/fault/restart rehearsals and the
   readiness/checkpoint records pass, select readers/writers/routing and start
   consumers together under the runbook. The external ingress stays closed during
   startup until the whole selection is verified. No runtime cross-service SQL.
   After new writes, rollback needs a data-aware procedure, not the old snapshot
   alone. Shared activation flags remain false until that separate cutover gate.

Only an explicitly delegated deployment/cutover operator with host/DB privileges
may run these tools, never a browser customer/provider or public API. B defines
and tests the concrete least-privilege credentials/access and secret handling in
the operator runbook before use. This document creates no new application role.

## Delivery order and ownership

1. **A first:** publish versioned manifest/hash and contract v1.1 schemas, canonical
   fixtures, request/result/error cases and callable interfaces. Preserve v1 new-mode
   and COD behavior; new gateway binding form cannot be sent to an old provider.
2. **A/C in parallel against those fixtures:** C implements006, appended Booking
   upgrade, eligibility/financial reference checks, operator CLI and checker
   invariants; A implements classification/import/replay comparison, validation/
   clients/callers and existing UI statuses. B supplies operator auth/access.
3. **A/C/D/E acceptance:** synthetic13/14/15 plus terminal cohorts; identical versus
   changed manifests; wrong-owner/amount/hash and dual-reference rejection; schema
   preservation; partial owner apply/rollback; paid/unpaid/void/fence behavior;
   repeated commands/receipts; webhook/cancel/complete races and crash/restart.
   Fresh authenticated stack proof is not a useful-data migration by itself.
4. Only after those proofs, execute the separately reviewed real checkpoint and
   coordinated cutover. No additional policy approval is needed to start the
   selected implementation; unsafe details still require coordinated revision.

## Rejected alternatives / contingency

Fabricated historical create-command IDs and lazy runtime adoption remain rejected.
Drain-before-cutover is available only as an explicitly selected contingency:
stop new legacy gateway bookings, finish or safely cancel/refund existing ones
under a reviewed customer/financial policy, then verify no open gateway orders.
It is not a silent fallback when binding validation fails.
