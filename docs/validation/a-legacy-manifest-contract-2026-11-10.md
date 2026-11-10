# A legacy manifest/financial v1.1 static conformance — 10 November2026

Base main84f2542, the merged lead-selected PR60 baseline. A-led AI-assisted
implementation supplies schemas, synthetic files, independent golden hash vectors,
reference validators and exact C owner-row/wire fixtures. Runtime/importer/schema
and useful data were not modified. The existing v1 spec/fixtures remain unchanged.

## Observed validation

- Original contract suite after the dev validator factory extraction:30 pass.
- Updated local suite:46 pass,0 fail,0 skip.
- Node22.23.4/Python3.11.2 in a network-disabled container, read-only contract/current
  service-source mounts:46 pass,0 fail,0 skip. This reused installed unchanged
  contract dependencies; exact-head CI installs `contracts/package-lock.json`
  afresh. No SQL/HTTP/application process or owning database was started.
- OpenAPI parser accepts target1.1. All old provisioning/COD operations/results
  remain valid in1.1; old v1 rejects legacy request fixtures. Routes/auth/callable/
  status/public-projection definitions are preserved.
- Both JS and independently implemented Python reproduce the checked-in core UTF8
  hex/digest. Tests reject duplicate keys, malformed/unsafe encoding/numbers,
  wrong hash/order/reference/context, dual references, COD references, mixed cohort
  states, duplicate/sorted identities and invalid ledger associations.
- Raw bundle/backup hash and header/watermark checks reject changed artifacts;
  owner binding projections match fixed fixtures, with no fabricated saga/command
  IDs or regenerated historical timestamps. `backup.fixture.txt` is deliberately
  non-SQLite hash input, not backup validity evidence.

An initial container attempt mounted contracts at `/contracts`, breaking two
inherited tests' relative imports of service envelope/projection modules. Correct
repository-relative read-only source mounts restored the whole46-test run. No
assertions were skipped or application behavior weakened to pass.

## Deliberate evidence boundary

These checks establish interface/byte conformance, not source eligibility,
consistent SQLite/WAL backup, operator authority, real owning transactions,
006/Booking binding existence, settlement/fences, current gateway charge, runtime
validation, replay/race/recovery or any historical cutover. Future A/C code must
perform those checks and integration/rehearsal against the frozen owners. The
current runtime still uses v1; target1.1 is not enabled or auto-negotiated.
No activation flags, routes, actual data, database schemas or dependency versions changed, and no new business service
was extracted. The parent offline/cutover/mixed-source gates remain mandatory.
