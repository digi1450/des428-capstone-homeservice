# A legacy manifest export

11 November 2026. Implements export/classification only, following
[the exact manifest contract](legacy-manifest-contract-handoff.md).
AI assisted implementation and tests.

The existing read-only command now atomically publishes four private files:
`notifications.json`, `payments-wallet.json`, `source.sqlite`, `manifest.json`.
The SQLite backup contains full retained source data, including private profile
and credential hashes. Keep the ENTIRE directory outside Git, private and under
operator control. The directory is0700 and files0600. No backup contents belong
in logs, CI artifacts or shared evidence.

```sh
python3 -B tools/data-migration/export_snapshot.py \
  --source /absolute/path/to/frozen.sqlite \
  --output output/migration/new-snapshot --writers-stopped
```

The operator must freeze ALL writers/relay/recovery beforehand. The flag is an
attestation, not a distributed lock. The tool opens one read-only SQLite
transaction, preserves existing integrity/FK/distributed-state/attention guards,
and uses SQLite backup API from that SAME transaction. This includes committed
WAL rows; hashing a copied main file would not be sufficient. Source files are
not rewritten. Output publication happens only after bundles, backup and manifest
are complete. A failed export removes its temporary files; existing output is
refused. Reuse the exact approved output on retry, not a fresh export/snapshot ID.

Every order receives a classification count in the sanitized command report.
Open gateway orders require exactly one intent and either awaiting/pending/
requires_payment with no ledger, or confirmed/paid/succeeded with exactly one
matching successful charge. Only those rows receive `open_unpaid`/`open_paid`
bindings. Terminal gateway and COD history are retained without bindings;
unknown state combinations or contradictory intent/ledger context stop export.
Numeric fixture IDs are never eligibility rules. Source orders in other active
states require explicit review; the tool does not silently omit them.

The manifest uses the exact v1 canonical sorted-key UTF8 encoding and full SHA256,
with sorted order IDs and owner bundle names. Hashes cover the exact raw bundle
files and generated consistent backup bytes. No derived binding IDs enter the
hashed core. Empty eligible bindings is valid if all source orders classify.

`schema_fingerprint` is SHA256 of compact sorted-key UTF8 JSON of the ordered
array of `[type,name,tbl_name,sql]` from SQLite `sqlite_master`, excluding names
matching `sqlite_%`, ordered by `type,name`. SQL text is retained exactly, including
whitespace. This is a source identity fingerprint, not an allow-list approval:
C's offline CLI must recompute it on the frozen backup, compare the reviewed
source/checkpoint and separately verify its supported schemas before writing.

A new contract regression actually exports a synthetic SQLite DB then passes its
raw manifest/backup/bundle bytes to the independent JS schema/hash/artifact
reference. Python regressions cover classification, private output, source
preservation, wrong open context, non-fixture IDs and inherited WAL/guard cases.
Local Python20 and contracts47 tests passed. Local Docker was unavailable during
implementation; two-owner PostgreSQL regression is delegated to the existing
`Offline legacy migration rehearsal` PR CI and must be checked before merge.

Remaining: C006/eligibility/Booking CLI/checker; A importer atomic bindings/replay
and runtime v1.1 receiver/client/UI; B operator permissions; real historical
checkpoint/partial apply/rollback/restart/race rehearsal and reviewed cutover.
This tool creates no owner DB bindings and does not enable application flags.
