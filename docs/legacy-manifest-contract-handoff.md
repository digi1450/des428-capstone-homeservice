# A manifest v1 and financial contract v1.1 — exact conformance handoff

10 November2026, based on main84f2542 after the lead-selected
[legacy binding baseline](c-legacy-binding-proposal.md). This implements A's
**interface-artifact step1**, with AI assistance. It does not implement the
exporter/importer, migration006, Booking CLI, runtime reference validation or
legacy settlement/finalization eligibility. Those are subsequent A/C work.

## Authoritative files

- [Manifest JSON Schema](../contracts/legacy-payment-manifest.schema.json), draft7,
  defines the strict v1 envelope/core and eligible initial state forms.
- [Portable fixture directory](../contracts/fixtures/legacy-payment-manifest/)
  contains `core.json`, canonical `manifest.json`, `golden.json`, exact owner bundle
  files and deterministic `binding-rows.json`. All IDs/content are synthetic.
  `backup.fixture.txt` is deliberately NOT a SQLite database: it supplies known
  bytes for the hash test, never consistent-backup or source-eligibility proof.
- [Target financial OpenAPI1.1](../contracts/financial-finalization-v1.1.openapi.json)
  is separate from the retained [v1.0](../contracts/financial-finalization.openapi.json).
  Current runtime remains v1. Both gateway provisioning and COD examples/results
  remain accepted by target1.1. Nothing negotiates/activates the new form today.
- [Legacy operations/results](../contracts/fixtures/financial-finalization-v1.1.json)
  demonstrate the four completion/cancellation initial paid/unpaid scenarios.
- Dev-only [manifest reference](../contracts/validation/legacy-payment-manifest.mjs),
  [financial1.1 reference](../contracts/validation/financial-finalization-v1.1.mjs),
  [Python byte reference](../contracts/validation/canonical_manifest.py) and tests
  under `contracts/test/` supply mandatory structural/cross-field/hash rules.
  Runtime services must not import the AJV/dev tools as their implementation.

## Exact manifest v1

Envelope: `{manifest:<core>,manifest_sha256:<64 lowercase hex>}`. Unknown properties
are forbidden. The core has exactly:

| Field | Shape |
|---|---|
| `format_version` | integer1 |
| `snapshot_id` | canonical lowercase UUID, matching both owner bundles |
| `source` | `{sqlite_backup_sha256,schema_fingerprint}`, each full64hex |
| `legacy_event_watermark` | integer0..9007199254740991, matching both bundles |
| `bundles` | exactly two entries sorted notifications then payments-wallet; each `{service,file,sha256}`, with literal owner filename `<service>.json` |
| `bindings` | entries sorted by ascending numeric order_id; unique order/intent IDs and charge reference IDs |

Binding entries have `order_id,intent_id,customer_id,provider_id,amount_cents,
currency,payment_method,eligibility,order_status,payment_status,intent_status`.
Domain IDs are1..2147483646; minor units0..2147483646. This matches the existing
importer's conservative INTEGER/next-ID boundary, not the broader live wire
contract's INTEGER maximum. Currency is THB and method is gateway.

- `open_unpaid`: awaiting/pending/requires_payment; NO charge_transaction_id.
- `open_paid`: confirmed/paid/succeeded; REQUIRES positive charge_transaction_id.
- No terminal/COD entry, optional authority field, OTP/profile/token, generated
  historical create-command/saga ID or derived binding ID is permitted in the core.
- Empty bindings is valid for a source with no eligible open gateway orders. It
  does not prove no unknown/unclassified open order exists: the source audit must
  account for every order. Never hardcode fixture IDs13/14 as classification logic.

Hash the core's canonical UTF8 bytes with SHA256 and use all64 lowercase hex.
Canonicalization recursively sorts ASCII object keys, uses integer-only safe JSON
numbers and no insignificant whitespace; arrays preserve their already validated
service/order sorting. All string values permitted by v1 are ASCII. Negative zero
normalizes to0. No floats, NaN, infinity, boolean/null values or unsafe numbers are
part of this v1 core. Future additional formats require a versioned review.

The envelope file is also canonical JSON, optionally followed by ONE LF. The Node
strict parser rejects pretty/noncanonical envelope encodings, BOM, invalid UTF8,
duplicate/escaped duplicate keys or trailing bytes; parsed-object validators alone
cannot establish that raw-file property. `core.json` is a readable fixture, while
`manifest.json` is the actual canonical envelope example. Python independently
produces the core bytes/hash, including rejection of duplicate input object keys.
`golden.json` publishes the exact core UTF8 hex and expected digest for C ports.

After hashing, derive `binding_id = legacy:<manifest_sha256>:<order_id>` with decimal
order ID and no leading zero. IDs are outside the hashed core (no circular hash).
An identical approved file/manifest is reused for retry; no regeneration of a
snapshot or new IDs to get around a partial import.

## Artifact and owner-row conformance

`assertManifestArtifacts(envelope,{backupBytes,bundleBytes})` checks exact backup
and raw bundle-file digests, owner/header/snapshot/watermark equality and that each
eligible entry matches its imported intent/context and expected initial ledger.
Unpaid entries have no order ledger; paid entries have exactly the matching
succeeded gateway charge and no refund/payout/commission. Mutating byte whitespace
in a bundle changes its digest, even if parsed JSON looks equivalent.

This helper does NOT open SQLite, prove WAL consistency/frozen writers/schema
fingerprints, compare every source order or replace the existing full owner bundle
validator. It cannot establish operator approval, authenticated user identity,
current settlement, fences, locks, queue quiescence or database transactions.
Those runtime/source/operator checks remain mandatory. A digest is integrity,
not authority to create/adopt a binding or perform financial operations.

`bindingRowsFor(envelope,'payments-wallet'|'booking')` is the deterministic
projection reference. Exact arrays are in `binding-rows.json`:

- Payments: `order_id,binding_id,manifest_sha256,intent_id,customer_id,provider_id,
  amount_cents,currency,eligibility`.
- Booking: `order_id,binding_id,manifest_sha256`.

Payments `created_at` is owner-local first-apply audit metadata, outside the
manifest-derived row projection. Identical replay preserves it; it is not a
synthetic historical timestamp regenerated on retry. A/C must review schema006,
replay comparison/target guards and the operator checkpoint before either writer.
No row is inserted by these reference functions.

## Financial v1.1 wire and callable interface

Routes, Idempotency-Key format, operation UUIDs, auth/permission labels, response
states/statuses, public Booking projections and C callable wrappers stay as v1.
See the [retained exact v1 handoff](financial-finalization-contract-handoff.md).
The gateway request body requires exactly one reference form:

```js
provisioning: { create_command_id, saga_id } // new-mode saga, unchanged
// OR
legacy_binding: { binding_id, manifest_sha256 } // approved imported old order
```

COD forbids both. Each reference object is strict. Beyond JSON Schema, validate
that binding ID embeds the exact full manifest hash AND request order ID.
`assertFinancialRequest` and `assertFinancialResult` enforce that relation,
header/operation equality, full immutable result-request echo and commission math.
`assertLegacyManifestContext` demonstrates matching owners/amount/currency against
a validated manifest entry; it is not a lookup of an actual approved persisted DB
binding and cannot replace C's locked eligibility check.

The same C methods remain `complete/cancel({callerId,commandId,request,context})`
returning `{replayed,result}`, and `get({callerId,commandId,context})` returning the
saved operation or null. B's stable Booking caller and distinct mock-gateway
webhook verifier are unchanged. A new operation UUID for an actual post-cutover
completion/cancellation is legitimate; fabricating a historical provisioning saga
or changing the saved command/request on retry remains forbidden.

Legacy cancellation may be ready `voided` or `refunded` (with the corresponding
intent/refund reference and settlement_fenced:true), pending or attention.
It cannot be ready `no_payment`: a binding necessarily refers to an imported intent;
missing intent/context requires reconciliation. Existing provisioning/COD
`no_payment` cases remain unchanged. A legacy unpaid source may later settle and
complete normally; snapshot eligibility is not a permanent assertion of its
current payment state. Current charge/fence/payout rules still apply under locks.

| Condition | Target interpretation (existing v1 status vocabulary) |
|---|---|
| Invalid/missing/dual reference, embedded hash/order mismatch |400 invalid financial request; never success/fence |
| Well-formed reference but approved DB binding/legacy context absent |409 attention legacy_reconciliation_required |
| Existing binding differs from order/owner/amount/currency/hash |409 attention context_mismatch |
| Same accepted caller/key but changed kind/request/reference |409 FINANCIAL_COMMAND_CONFLICT; preserve original result |
| Valid ready/pending/attention result |POST200/202/409; GET200 inspects matching result, never assumes readiness |
| Unknown result/timeout/malformed success |Same durable pending work/recovery; never infer release/refund |

The four fixture operations/results are transport/conformance examples, not an
actual saga/settlement run. Deploy upgraded receiver and callers together before
sending legacy requests; old runtime v1 must continue to reject the new form.
Do not switch to invented provisioning as fallback. The existing16KiB body,
strict JSON, no-extra-query, auth/owner checks and terminal/OTP/slot guards remain.

## Next implementation handoff

1. C implements reviewed006/eligibility/financial/Booking CLI/checker against these
   exact shared fields. Append Booking upgrades after E's metadata, preserve work
   and trace context, and review the existing importer/startup allow-lists with A.
2. A implements exporter classification/manifest publication, same-transaction
   Payments bindings/replay, actual v1.1 runtime validation/client/callers and UI.
   Reuse the formats here; the dev reference is not production implementation.
3. B supplies concrete least-privilege operator access. A/C/D/E rehearse all cohorts,
   wrong reference/hash/context, partial owner apply/rollback, replay/race/restart
   with real auth, then execute the separately reviewed checkpoint/cutover.
   No binding creation from a web request and no half-owner activation.

Run `npm test --prefix contracts` (Node22+ and Python3 on PATH). The existing
`API schemas and fixtures` CI job runs the new tests through `test/*.test.js`.
See [dated static conformance evidence](validation/a-legacy-manifest-contract-2026-11-10.md).
