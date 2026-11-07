# Selected A/C participant decisions — 7 November 2026

Status: lead-selected decisions from the team lead's five answers, recorded for A/C/B/D/E implementation. This document does not implement or activate endpoints. Existing [payment draft](../contracts/payment-intents.openapi.json), [adapter handoff](payment-adapter-handoff.md), [C saga](c-saga-handoff.md) and [Payments hooks](payments-business-handoff.md) remain the starting point; amend contracts/callers/tests together for the missing activation step.

## Confirmed choices

| Question | Lead-selected answer |
|---|---|
| Ownership | A implements HTTP endpoints, validation/transport and monolith callers. C implements Payments command/result storage, cancel fence and settlement eligibility. Coordinate shared files; do not independently implement duplicate stores. |
| Existing API | Reuse the current create/query/cancel-by-command draft, stable command keys and conflict on changed input. Review only additions/gaps rather than redesign the whole interface. |
| Activation | Add an internal confirm/activate HTTP operation. Booking persists its intent-to-activate durably and retries the SAME activation command after failures/restarts. |
| Booking response while activation is unconfirmed | A successfully provisioned booking can be shown as booked, with payment setup pending. Payment actions remain disabled until Payments acknowledges effective eligibility. Do not label the booking unpaid-intent creation itself as payment-ready. |
| Provider wallet | Persist provider registration and durable wallet-provisioning work in ONE monolith transaction, then deliver to Payments asynchronously with idempotent effects. No network call inside SQLite transaction and no duplicate/reset wallet on retry. |

## HTTP and ownership handoff

Existing draft routes retain their paths:

- `POST /internal/payment-intents`
- `GET /internal/payment-operations/{create_command_id}`
- `POST /internal/payment-intents/cancel-by-command`

A's concrete proposed additive route for C/B/E review is `POST /internal/payment-intents/activate-by-command`. This path and the following technical details are an implementation proposal, not an already-served endpoint or finalized OpenAPI shape: reference the original `create_command_id` and `saga_id`, validate the trusted booking/intent context, and use a distinct stable activation Idempotency-Key. Authorize Booking's service identity through B; do not trust arbitrary customer/body/header identity. A/C must write the precise request/response/error fixtures and callable C interface before parallel implementation.

C owns participant-side migrations/repository and transaction semantics. A owns the HTTP wrapper and client/Booking mapping. Prefer a separate command module/router over rewriting each other's business service file. C passes the same transaction client into A business effects and outbox writes where applicable; one transaction must cover command result/fence/eligibility and its financial effects. Use the existing agreed lock order, no cross-service SQL and no HTTP inside a local SQL transaction.

## Required ordering and safety

1. Create intent remains ineligible for settlement. Binding order/customer/provider/amount/currency, saga and original command must remain immutable; matching retries converge and changed input conflicts.
2. Booking commits its successful provisioning state AND activation work/key in one SQLite transaction. Public order status remains the existing `awaiting`; saga `COMPLETED` means provisioning complete, not paid and not proof Payments already accepted activation.
3. After commit, deliver activation outside the SQLite transaction; on unknown response retain durable pending work and retry the same command/key/body. Do not create a second booking/intent, release slots or roll back a successful booking solely due to activation timeout.
4. Activation must only enable the matching completed provisioning and must atomically check fences/terminal states. A delayed activation cannot clear a cancel fence or revive a cancelled/compensated booking. Concurrent activation/cancellation must serialize with settlement; a settled payment requires refund/reconciliation, not an unpaid void.
5. The Payments `assertSettlementAllowed` hook reads locally persisted effective eligibility under the order lock; a stored successful create or a stale activation response is not sufficient authority. C/A must define response/replay behavior after a later cancellation so no caller mistakes historical activation acceptance for current payment readiness.
6. Payment setup state is separate from intent status and public booking status. A adds the explicit pending/ready representation and UI behavior as a reviewed contract extension; do not silently add fields to existing strict client responses or enable pay just because an intent exists. Server-side settlement gating is mandatory even if a stale browser enables the button.

The original saga recovery covers create/cancel, not this new activation delivery. C extends durable activation state/work selection; A integrates its caller. Restart/lease/retry tests must cover this added work. D owns retry configuration; no new numeric policy is selected here.

## Wallet handoff

A updates registration callers/UI when C's durable provisioning record/event is ready. C implements transaction-bound recording, delivery/recovery and dedupe using stable provider identity and work identity. Payments uses existing `provisionWallet(providerId,{client})` without resetting balances. The transport/event name and schema are still a technical interface to record jointly; the lead selected asynchronous delivery, not a specific queue/event name.

Do not represent a pending wallet as verified migrated zero balance or let financial effects disappear during provisioning. A/C must preserve registration compatibility and define pending/ready/failure visibility. Legacy direct SQLite wallet creation is retired only at coordinated caller/data cutover.

## Next work and acceptance

- First: A/C agree the exact callable command/activation interface, route fixtures and migrations with the owners above; B specifies service principal/claims and scopes. Fail-closed injection permits isolated tests before real Keycloak, not live activation.
- C can begin its participant command/fence/eligibility module; A implements HTTP/client integration against that interface, then updates Booking activation delivery/payment-ready UI. Do not mount placeholder-success endpoints or enable saga with fake credentials.
- Verify create retry/changed input, absent-create fence then late create, activate retry/lost reply/restart, activation vs cancellation races, settlement before/after readiness, and idempotent wallet provisioning after restart.
- E uses completed HTTP boundaries for Pact and then real cross-service tracing; drafts/fixtures alone are not provider verification. Root broker/IdP wiring and final cutover remain separate integration work.
- Independently review C's importer version-pin change and additional tables before real import; these decisions do not approve data migration or destructive startup.
