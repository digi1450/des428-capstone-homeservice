# Financial v1.1 runtime: strict transport preparation

First slice of remaining Area A step1, following PR65/71. Service-owned validation
and the monolith financial client validators accept exactly one provisioning OR
legacy_binding reference on gateway requests; COD accepts neither. Legacy binding
IDs must embed the exact full lowercase manifest hash and request order ID.
Result echoes remain immutable; legacy cancellations cannot report no_payment.
Existing financial-client methods automatically use the updated validators.
No dev contract validator is used by runtime modules.

The financial receiver explicitly stores/replays attention with
legacy_reconciliation_required for legacy references. It skips the provisioning
lock for that form and performs no provisioning, financial fence or money writes.
This is fail-closed transport preparation, NOT database eligibility. Sending a
legacy command early creates terminal attention; keep traffic/cutover disabled
and never invent another command ID to bypass attention. No Booking caller emits
a legacy reference yet. Settlement continues refusing imported intents.

Remaining step1: implement reviewed locked Payments binding/intent/context lookup,
legacy completion/cancellation and shared settlement/fence checks; Booking additive
bindings/CLI, snapshots/readiness/callers/UI and coordinated checkpoint rules.
Step2 retains operator permissions, source/owner reconciliation, cohort/race/
restart/partial apply/rollback and actual cutover. A reference alone is not approval.

Validation: Linux Node20 monolith302/302; real PostgreSQL Node22 financial suite
16/16, zero skips/failures. Covers v1.1 shared vectors/mutations across BOTH actual
validators and durable receiver attention/replay/no-effects. Current provisioning,
COD and financial HTTP regressions remain in the suite. Disposable PG/network
cleaned. Full new-head CI remains pending. No useful data or activation changed.
AI assisted. This is not completion of Area A or full v1.1 runtime integration.
