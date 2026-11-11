# A importer manifest preflight

11 November2026. Preparation for importer binding support; C schema006 is absent
from main at implementation time. Existing service migration files stop at005.
This slice does not implement binding insertion or change the importer allow-list.
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

The existing `import-cli.mjs` remains the old owner-bundle importer. It does NOT
call this preflight automatically, insert legacy bindings or make old gateway
bookings eligible. Do not treat a successful old import as completion of this
workflow or open traffic. Future integration must capture validated bytes/binding
projections and target checks before the same local Payments import transaction.

Tests:28 Python tests (20 inherited exporter +8 preflight), including rehashed
omission/owner mutation, backup mutation, schema mismatch, external digest,
noncanonical/symlink input and byte-for-byte source preservation. Existing
migration CI now discovers both Python test modules and runs the unchanged
isolated PostgreSQL owner regression.

## Required next C/A handoff

C supplies reviewed006 binding schema/constraints, eligibility lookup and Booking
CLI/checker against the exact fields in
[manifest contract](legacy-manifest-contract-handoff.md). A then implements the
reviewed006 allow-list, same-transaction Payments business/binding insertion,
identical replay including bindings, dry-run rollback and partial/conflicting
state rejection. Preserve owner-local created_at on replay. No duplicated A
binding store, fabricated historical provisioning or runtime binding adoption.

Then connect financial1.1 receiver/client/UI and B least-privilege operator access;
rehearse both owners/checkpoint/partial apply/rollback before any actual cutover.
