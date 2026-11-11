# A importer manifest preflight

11 November2026. Resumed after PR66 delivered schema006. Includes approved
artifact preflight and Payments-local atomic business/binding import. Runtime
eligibility and the two-owner checkpoint are still separate gates.
AI assisted implementation and tests.

```sh
python3 -B tools/data-migration/verify_manifest.py \
  --directory output/migration/approved-snapshot \
  --expected-manifest-sha256 <operator-reviewed-full-64-lowercase-hex>
```

The expected digest must come from the independently reviewed checkpoint. Reading
the digest from the same untrusted manifest proves no approval. The tool checks
canonical manifest bytes and the full core digest, exact backup and owner-file
hashes, then uses a private temporary copy of the backup to rerun the read-only
source exporter/classifier. The entire binding list, schema fingerprint, source
watermark and owner rows must match that source. A self-consistent rewritten hash
cannot hide a missing eligible booking or replace bundle rows. No application
bootstrap, service connection, import, owner binding creation or external command
is used. Original approved files and adjacent sidecars are not opened by SQLite;
private temporary copies/exports are removed on exit. The full backup contains
private data; never upload it or derived owner bundles as evidence.

Output is sanitized status/digest/snapshot/count only. CLI errors return nonzero
with one generic code, without file paths, SQL errors or private row contents.
A pass proves artifact/source consistency under the existing source guards. It
is not a distributed freeze lock, authorization, target schema approval, B identity
eligibility, target DB comparison or cutover approval. Freeze writers and retain
approved immutable files throughout eventual apply; verify again if files change.

The original owner-bundle CLI remains available and still requires EMPTY bindings.
Use the explicit approved mode to import bindings:

```sh
node tools/data-migration/import-cli.mjs payments-wallet \
  --approved-directory /absolute/private/approved-snapshot \
  --expected-manifest-sha256 <independently-reviewed-full-digest>
# Dry-run by default; add --apply only for the reviewed frozen owner phase.
```

Node22 and Python3 are required. The Python preflight returns its already-read
verified payload through private captured IPC (64MiB limit,120s timeout), never
logs it, and never rereads owner files after verification. An opaque process-local
handle prevents callers from supplying arbitrary binding rows or a forged report.
No dev-only AJV/reference validator is imported by this administrative path.

Both owner bundles are validated against the SAME source, but only the selected
owner credential is loaded. Notifications imports its existing owned rows only;
Payments locks business, bindings and all existing C work/dedupe/fence tables.
Only an entirely empty business/binding target or an exactly identical combined
business/binding replay is accepted. A previously business-only import with
missing bindings is rejected, not silently repaired. Message/work state must
remain empty even on replay. Business and bindings are inserted in one local
transaction; dry-run rolls back rows and identity restarts. Identical replay
preserves binding created_at. Conflicting/extra/partial bindings fail closed.

A failed second owner phase does not undo a committed first owner phase. Keep
all writers/traffic frozen; retry the unchanged approved package only after the
operator reviews target state. There is no distributed commit/checkpoint here.
Empty eligible-binding sets remain valid; they do not persist a standalone manifest
checkpoint, so artifact identity for that case still needs the operator checkpoint.
The checker intentionally reports nonempty bindings as attention until coordinated
Booking/checkpoint reconciliation is implemented. No runtime financial eligibility
or activation flag changes with this importer.

Tests:28 Python tests (20 inherited exporter +8 preflight), including rehashed
omission/owner mutation, backup mutation, schema mismatch, external digest,
noncanonical/symlink input and byte-for-byte source preservation. Existing
migration CI now discovers both Python test modules and runs the unchanged
isolated PostgreSQL owner regression.

## Required next C/A handoff

PR66 supplies006. C/A still implement eligibility lookup and Booking
CLI/checker against the exact fields in
[manifest contract](legacy-manifest-contract-handoff.md). This PR implements the
reviewed006 allow-list, same-transaction Payments business/binding insertion,
identical replay including bindings, dry-run rollback and partial/conflicting
state rejection. Owner-local created_at is preserved on replay. No duplicated A
binding store, fabricated historical provisioning or runtime binding adoption.

Then connect financial1.1 receiver/client/UI and B least-privilege operator access;
rehearse both owners/checkpoint/partial apply/rollback before any actual cutover.

## Resumed importer validation

Local final run: Python28/28 and Node22 real-PostgreSQL44/44, zero failures/skips.
Includes approved CLI dry-run/sanitized failure, opaque-proof rejection, atomic
rollback after binding insert failure, exact projections, unchanged created_at
on replay, missing/conflicting bindings, active work rejection and captured-byte
replacement protection. Old two-owner import/business-continuation regressions
remain passing. Disposable PostgreSQL containers/network cleaned up. Initial
macOS system-Python WAL test failed; Homebrew Python and final Linux Python bridge
passed. An initial new fixture cleanup omitted an FK-referencing table; explicitly
naming payment_provisioning corrected the fixture without weakening constraints.
No useful data, real operator checkpoint, runtime v1.1 or full-stack acceptance
was exercised. GitHub CI for the updated head is separate pending evidence.
