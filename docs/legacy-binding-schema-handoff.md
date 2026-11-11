# A-led C schema006 preparation

11 November2026. The lead explicitly requested A implement schema006 on C's
behalf. Implements the Payments-owned table shape from the merged exact manifest
handoff. AI assisted implementation/tests. No Booking extraction or runtime
legacy eligibility is introduced.

`006_legacy_payment_bindings.sql` adds `legacy_payment_bindings` with fields:
order_id,binding_id,manifest_sha256,intent_id,customer_id,provider_id,amount_cents,
currency,eligibility,created_at. Primary order ID, unique intent/binding IDs,
canonical full hash/derived binding ID, manifest numeric bounds, THB and the two
initial eligibility forms are enforced. A composite local FK ties all intent
identity/owner/amount/currency fields to the SAME payment_intents row; referenced
context cannot diverge while binding exists. Intent status is deliberately not
part of the FK: an initially unpaid imported intent may legitimately settle.

The database does not prove manifest approval, source hashes, initial ledger,
Booking owner/checkpoint, absence of conflicting work or immutable command replay.
The future offline importer must validate these and write business/binding rows
in one local transaction. No runtime request may adopt/create a binding. Future
writers must reject changed binding context and preserve created_at on replay.
This DDL does not expose an HTTP endpoint or implement eligibility lookup.

Readiness requires006. Existing migrations/checksums are untouched. The legacy
importer allow-list advances to006, locks the new table and REQUIRES it EMPTY.
It still inserts only old business rows; importer binding support is the NEXT
slice. No clearing of bindings or weakening of message-state guards is allowed.
The read-only consistency checker requires the new table and reports any binding
as attention until two-owner manifest/checkpoint reconciliation is implemented.
Its clean report must not imply unimplemented legacy consistency checks.

New real-PG regression verifies exact-context FK, wrong hash/derived ID/enum,
duplicate rejection, repeatable migration and atomic business/binding rollback.
Importer fixture cleanup explicitly names the referencing table, preserving FK
constraints rather than using CASCADE. CI must run these on isolated databases.

Next A: use PR65 preflight, implement approved artifacts and atomic binding
insertion/identical replay/dry-run. C/A: eligibility logic and Booking additive
upgrade/CLI/checker with exact shared fields. B: operator authority. Only after
receiver/client/UI and historical checkpoint/rehearsal may cutover be considered.
