# Area A step1 stacked integration evidence

> Current-status note — 12 November2026: [A–E status](current-area-status.md)
> and [actual local cutover](validation/a-local-cutover-2026-11-12.md) supersede
> earlier pending/unmounted/unwired/no-cutover labels in this historical handoff.
> PR73–78 are merged; auth/callers/owners and approved local deployment are integrated.
> Keep the contracts, safety requirements and original test limits below. Shared
> defaults remain gated; this local result does not approve another deployment
> or close D's broader races/browser/offline/submission work.

Stack order: PR73 Payments eligibility -> PR74 Booking bindings/callers -> this PR.
These branches preserve commits and do not imply merged/approved status. Retarget
later PRs onto main only after their predecessors merge; inspect their latest CI.

The new dedicated CI job runs the actual legacy Booking/financial/payment clients,
HTTP routers, C durable operations and owning PostgreSQL against synthetic exports.
It imports the same verified artifacts into Payments and a retained Booking file.
Bound/half-applied checkpoint blocks payment and finalization before work is saved.
A synthetic operator approval then permits remote reads/simulation, legacy completion
and refund without inventing provisioning/saga identities. The cancellation reply
is deliberately lost AFTER its HTTP commit; Booking keeps slot holds and the saved
request/key until a separate Node process resumes production recovery from that
file. Only after replay confirms the refund does Booking release the slot. Ledger
assertions prove exactly one charge/payout/refund, no local SQLite ledger changes,
and no fabricated provisioning. Credentials/verifiers are explicit fixture doubles;
this is not new real-Keycloak/B operator or AMQP/graphical-browser evidence.

Integration review also makes dual persisted binding+provisioning/saga ambiguous:
no ready settlement or Booking readiness and financial context reconciliation.
Other locks/fences and callers remain unchanged.

Local final results: monolith303/303 Linux Node20; financial+legacy PG21/21 Node22;
actual HTTP/PG/separate-process recovery integration1/1; Python28/28 and existing
two-owner PG importer44/44. All zero skips/failures. Temporary PG/network removed.
Only synthetic target files were used; all tracked activation flags unchanged.
New hosted CI results are pending, so step1 code is prepared, not yet accepted.

Remaining step2: B least-privilege operator authority, independently approved
manifest and both phase receipts, frozen/drained sources/brokers, read-only checker
checkpoint reconciliation, all historical cohorts/partial owner apply/rollback/
wrong references/restart/race rehearsals and reviewed useful-data cutover/routing.
The CLI intentionally cannot mark a checkpoint approved, and default Payments
approval is absent. Do NOT copy synthetic approval SQL into deployment instructions.
A completed step1 integration does not remove these gates. AI assisted.
