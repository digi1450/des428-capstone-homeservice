# A activation client/Booking adapter — 8 November 2026

Status: A step 2 adds the monolith transport and adapter for the activation HTTP route merged in #32. **Not live wiring:** no startup hook, worker enablement, UI/caller switch or Payments composition changes are included. B's real JWT verifier and C's reviewed recovery remain integration gates.

## Callable boundary and keys

```js
const adapter = createBookingPaymentsAdapter({ paymentsClient });
await adapter.activate({ createCommandId, sagaId, activateCommandId }, credentials);
// -> { create_command_id, saga_id, outcome: "activated" }
```

This matches C #29's proposed adapter call. All three identifiers come from persisted workflow state; the adapter does not generate them, retry, query SQLite, release slots or compensate a booking. The workflow is strict, requires existing key grammar/length, and activation differs from create. Conflicting `credentials.commandId` is rejected before HTTP; otherwise the supplied activation key is forwarded unchanged. C remains responsible for persisted cross-kind/target key reuse checks.

The client method is `activateIntent({create_command_id,saga_id},{...credentials,commandId:activateCommandId})`. It POSTs the strict body to `/internal/payment-intents/activate-by-command`, with the same bearer/correlation/trace handling, deadline and reject-redirect policy as existing methods. Fresh and replay acceptance require HTTP 200 and the exact matching create/saga/activated result. A result for another workflow, extra fields or unexpected success status is unconfirmed. No token is placed in the JSON body.

## Error contract for C recovery

| Actual response | Client error | Expected workflow treatment |
|---|---|---|
| 409, application/json, strict `{error,requestId,code:'PAYMENT_SETUP_CANCELLED'}` | `PaymentSetupCancelledError`, `statusCode:409`, reviewed `code`, original create/activate/saga identities | Activation blocked/attention; never automatically cancel or release the local booking |
| 409, application/json, strict `{error,requestId}` | `PaymentActivationConflictError`, `statusCode:409`, `reconciliationRequired:true`, no code | Reconcile/attention; not a fence |
| Timeout, lost reply, transport failure, 5xx, other unexpected status | `PaymentOutcomeUnknownError`, `operation:'activate'`, original create identity | Keep durable activation pending; caller may explicitly retry the same supplied key/body |
| Malformed/non-JSON/oversized/stalled 409 body, unknown code/private fields/invalid requestId | `PaymentOutcomeUnknownError`, `reason:'invalid_response'`, **no `upstreamStatus:409`** | Pending/unconfirmed, not a verified conflict or fence |

The new conflict reader bounds decoded data to 16 KiB before parsing and remains under the request's abort deadline. Neither error copies upstream error text, token or private payload into its message/properties. A bare 409 is insufficient: its JSON envelope must validate. The absence of `upstreamStatus:409` on malformed bodies is intentional so recovery cannot classify an unvalidated reply as reconciliation based only on status. Existing **create/query/cancel** unknown-error behavior is unchanged, including their 404/409 handling.

The adapter passes typed errors through; it never retries automatically. Error classes are exported from `lib/modules/payments/client.js`. C must retain its own validated-status check and unique-per-lease-claim fencing; adding this transport does not resolve the PR #29 review findings. No status/readiness is inferred from create replay or an existing intent. Real settlement eligibility remains Payments' server-side guard.

## Validation and next work

- Node 20 Docker monolith suite: **149 passed, 0 failed/skipped** (140 previous tests plus 9 activation client tests). Actual loopback HTTP cases cover metadata/key/body replay, dropped reply, coded versus uncoded conflicts, all relevant non-409 statuses with a false cancellation code, malformed/oversized/stalled bodies, identity/status mismatch, early validation and unchanged create/cancel errors.
- Node 22 + isolated PostgreSQL: Payments service suite **63 passed**; HTTP boundary suite **9 passed**, all 0 failed/skipped. New cases traverse the actual adapter/client → Express route → C participant → PG. A committed activation with a deliberately dropped reply retries to one stored activation command. A subsequent real cancel makes historical activation replay throw the typed fence and leaves the intent voided.
- Production standalone Docker image build passed on the copied source (Node 20 / Next 14). No application was started against useful data.
- Changed JS syntax and `git diff --check` passed; links checked. Contracts/schemas were not changed or rerun. The existing HTTP service/fixtures are exercised directly; B auth is an explicit test double, not real Keycloak.

Checks used copied tracked source and a cached Node 20 dependency image, plus a separate `homeservice-activation-client` PG16 tmpfs project/read-only repository mount with no host ports. Containers were removed. No useful DB, broker, real credential or other stack was touched.

Follow-up: [payment setup/callers](payment-setup-callers-handoff.md) now prepares Booking `payment_setup` visibility and detail/simulate/payment/wallet callers behind explicit injection; it does not activate production. Coordinate that with C's corrected state/migration/recovery and B's verifier before enabling traffic. The provider can now be tested against real C persistence without waiting for the UI; this does not complete Pact, full-stack tracing, legacy eligibility or cutover.
