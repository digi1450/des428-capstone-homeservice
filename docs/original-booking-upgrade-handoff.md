# Exact original Booking offline preparation — 11 November2026

> Current-status note — 12 November2026: [A–E status](current-area-status.md)
> and [actual local cutover](validation/a-local-cutover-2026-11-12.md) supersede
> earlier pending/unmounted/unwired/no-cutover labels in this historical handoff.
> PR73–78 are merged; auth/callers/owners and approved local deployment are integrated.
> Keep the contracts, safety requirements and original test limits below. Shared
> defaults remain gated; this local result does not approve another deployment
> or close D's broader races/browser/offline/submission work.

This follows the source-schema blocker found during [operator/checkpoint work](legacy-operator-checkpoint-handoff.md).
It prepares a **separate copy** of the approved instructor-era source for current
Booking; it does not modify the selected local source or open traffic.
The checkpoint PR and this source-upgrade follow-up are separate review units.

## Recognized source and preservation rules

`prepareOriginalBooking()` accepts only the exact original36-object schema,
including the original7-column `events` table. The approved snapshot verifier
captures actual `sqlite_master` objects from the same private bytes already
verified against the independently pinned manifest. No source schema is guessed
from a filename, an empty table or an operator flag. Extra/changed objects or
changed source/target rows are rejected. Normal application `migrate()` still
rejects this original schema; startup never performs this archival operation.

Within one offline SQLite transaction it:

1. Compares every retained source row to the approved source, before changes.
2. Copies old `events` rows verbatim into `legacy_event_archive`, retaining IDs,
   payloads and timestamps. Every old event must already be processed. Nothing
   is declared published, delivered or replayed as a financial operation.
3. Replaces the original event table with the current empty live event table and
   creates the missing reviewed objects. It adopts the exact current fingerprint
   without seed/reset/backfill, and checks all retained rows and ID sequences,
   foreign keys and target integrity before commit.

The archive has no runtime writer. Old records receive no fabricated event UUID,
provisioning saga or command ID. The existing event helper assigns **new** IDs
above both the live and archived maximum, and generates UUIDs only for those new
events. Dispatchers still read only live `events`; archived rows cannot be picked
up by the old relay or broker relay. This retires historical transport work; it
does not prove that a past `processed_at` stamp meant successful delivery.
Preserve the historical source effects/ratings and investigate any inconsistency;
do not replay old events or recompute money/ratings to make migration pass.

For already modern C/E databases, the appended runtime upgrade adds only an
empty archive table. Existing event UUIDs, publication attempts, leases, carrier
metadata and business work are preserved. Historical upgrade fixtures continue
to pin actual old fingerprints, including PR75 main `a1fa7d5`.

## Operator order and CLI

Keep the source frozen and all traffic/producers/recovery/consumers stopped as
specified in the checkpoint runbook. Back up and restore-rehearse first. Use the
exporter's standalone consistent `source.sqlite` backup, **not** a bare copy of
`edemand.db` while it has a WAL. Keep the pinned manifest and original snapshot
unchanged. Create a NEW private prepared directory with its own `edemand.db` copy.
The CLI requires an existing target and refuses the snapshot file itself,
including symlink/hardlink aliases.

```sh
node tools/data-migration/prepare-original-booking-cli.mjs \
  /absolute/new-prepared-booking/edemand.db \
  --directory /absolute/private/approved-snapshot \
  --approved-manifest-sha256 "$PINNED_MANIFEST_SHA256"
# Review dry-run first. Add --apply only for the reviewed COPY preparation.
```

A dry-run rolls back logical schema/data/counter changes. SQLite may create or
refresh its ordinary lock/WAL/SHM metadata; it is not a promise of unchanged file
padding. Failure mid-DDL rolls back the archive copy and restores the original
event table/data. Exact prepared replay is allowed only before new work/bindings.
After bindings or new effects exist, repeating this preparation is rejected;
use the appropriate binding/checkpoint/recovery procedure instead.

Then run both owner imports and the existing Booking binding CLI with the SAME
approved snapshot. Both Booking binding reconciliation and full-source checkpoint
inspection recognize the archive mapping **only for that exact original schema**;
all archived source rows must match, and live `events` must remain empty before
approval. Imports leave Booking `bound`, not approved. A prepared target with
archive history is rejected as a new legacy-only export source, preventing a
second migration that hides its transport retirement.

Proceed to the [signed operator checkpoint](legacy-operator-checkpoint-handoff.md),
identity/session sidecar validation and reviewed runtime directory permissions.
The receipt overlay selects this prepared directory explicitly, replacing the
baseline named monolith volume. Never mount signing keys/backups into runtime,
and never activate the old SQLite financial/notification writers as fallback.

## Observed validation and scope

[Validation](validation/a-original-booking-upgrade-2026-11-11.md) distinguishes
synthetic schema/fault tests, the selected local-source PRIVATE COPY rehearsal,
and fresh16-service authenticated/fault acceptance. No useful-data cutover was
performed. Hosted CI and final source freeze/identity/deployment go/no-go remain.
