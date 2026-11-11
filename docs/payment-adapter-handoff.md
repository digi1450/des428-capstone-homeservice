# Prepared monolith Payments client and Booking adapter

> Current-status note — 12 November2026: [A–E status](current-area-status.md)
> and [actual local cutover](validation/a-local-cutover-2026-11-12.md) supersede
> earlier pending/unmounted/unwired/no-cutover labels in this historical handoff.
> PR73–78 are merged; auth/callers/owners and approved local deployment are integrated.
> Keep the contracts, safety requirements and original test limits below. Shared
> defaults remain gated; this local result does not approve another deployment
> or close D's broader races/browser/offline/submission work.

7 November HTTP preparation update: [create/query/cancel shell and B/C adapter proposal](payment-command-http-handoff.md) is implemented and tested with explicit doubles. Production remains unwired/fail-closed; the activation route is reserved and settlement/cutover are still pending. Earlier unmounted-route wording below describes the previous business slice.

Status: transport and mapping code implemented/tested; existing monolith handlers, pages, Booking service and financial writers remain unchanged and do not import these adapters. Real auth, C mutation endpoints/command persistence/fences and coordinated cutover remain pending. This is not a completed service migration or a working public gateway payment flow.

## Client entry points

`bangkok-homeservice/lib/modules/payments/client.js` exports `createPaymentsClient({ baseUrl, timeoutMs = 2000, fetchImpl })` and `PaymentOutcomeUnknownError`. The base URL must be an HTTP(S) origin with no credentials/path/query. The timeout is an engineering default, configurable from 1–60000 ms, not a measured service SLA or a lead-selected deadline.

| Method | Inputs / existing draft interface |
|---|---|
| getWallet(credentials) | GET /api/provider/wallet; B's end-user provider token |
| listCustomerTransactions(credentials) | GET /api/customer/transactions; B's end-user customer token |
| createIntent(context, credentials) | Context matches draft CreatePaymentIntent: order_id, customer_id, provider_id, amount_cents, currency=THB, saga_id. credentials.commandId is the stable create Idempotency-Key; accepts 201 or stored-replay 200 |
| getOperation(lookup, credentials) | Lookup includes create_command_id, saga_id AND expected order_id/amount_cents from C's saved snapshot. Only the encoded command ID goes in the GET path; the other fields validate the response locally |
| cancelIntent(context, credentials) | Context: create_command_id, saga_id, reason=booking_setup_failed or booking_finalization_failed. credentials.commandId must be a DIFFERENT stable cancel key; only matching 200/cancelled confirms cancellation |

Credentials are `{ token, commandId?, requestId?, traceparent?, tracestate? }`. B supplies the correct audience/role token for each route: user credentials for reads, authorized service-caller credentials for internal commands. The client forwards no raw user/role headers, follows no redirects and reflects no upstream error bodies. One deadline spans response headers and body. C command scoping must use stable verified caller identity, not the literal rotating access-token string.

Command/saga keys must not be exactly `.` or `..`: URL parsing treats them as path navigation segments. Client, Booking adapter and the draft contract reject those values; ordinary dotted keys such as `..booking-42` remain valid.

No method generates command IDs, retries, changes Booking state or falls back to SQLite. D can wrap calls with its agreed retry policy; retries must preserve the original key, saga and saved body. Public rows use existing numeric IDs/integer cents/ISO dates and strip no fields silently: unexpected private fields/type drift fail validation. Every successful command response must match the create command and saga; created intents must match expected booking/amount and cannot be failed/voided. Query checks therefore also require the saved booking snapshot.

## Unknown outcome is not failure/compensation permission

`PaymentOutcomeUnknownError` has statusCode=503, outcomeUnknown=true, operation=create/query/cancel, createCommandId, a safe reason and optional upstreamStatus. It contains no bearer token, URL, upstream body or pricing payload.

- Transport failures, lost replies, timeout (including a stalled body), malformed or mismatched successful replies, and unexpected status codes produce UNKNOWN.
- Query 404 produces reason=lookup_missing. It does not return cancelled, create a new operation or prove a prior request cannot still commit.
- Command 400/401/403/409 and other HTTP errors also remain UNKNOWN: this generic error envelope provides no durable terminal evidence about an earlier attempt. C may inspect upstreamStatus for authentication/conflict/manual recovery, but must not release slots just because an HTTP error arrived.
- A validated created result confirms the corresponding intent context; a validated cancelled result is evidence only if C's server has really persisted the matching cancellation fence.
- Input/auth validation before a request can throw 400/401. Even this does not undo an earlier uncertain attempt: C must consider its existing durable saga history before deciding what to do.

The client stores no workflow history. C persists state and resumes the SAME command; D bounds retries/backoff. Never treat this error class as permission to delete a saga, mint another create key, mark a booking terminal or release its slots. Safe pending user responses/restart recovery remain C/D work.

## Booking mapping adapter

`bangkok-homeservice/lib/modules/booking/payment-adapter.js` exports `createBookingPaymentsAdapter({ paymentsClient })`:

- `prepare(order, workflow, credentials)` maps a trusted persisted order snapshot's id/customer_id/provider_id/total_cents into the create request. It sends no OTP, address, raw browser prices or other order columns. Gateway workflow requires `{ createCommandId, sagaId }` owned by C. COD returns undefined without HTTP, preserving omission of payment_intent in the original JSON response.
- `inspect(order, workflow, credentials)` uses the same persisted snapshot and workflow for a validated lookup. COD has no gateway operation to inspect.
- `cancel(workflow, credentials)` requires `{ createCommandId, cancelCommandId, sagaId, reason }`; keys must differ. Conflicting credential/workflow command IDs are rejected rather than overwritten silently.

These functions do not read/write orders, reserve/release slots or open SQL transactions. C commits the local reservation plus durable snapshot/key state BEFORE awaiting network calls; do not wrap them in the inherited better-sqlite3 transaction callback. Preserve that original snapshot across retries instead of recomputing a changed price. The returned operation envelope is for C to validate/persist; it is not automatically the public Booking success body.

## Current integration limits / next callers

Wallet/history routes exist in Payments but its runtime still has no real B verifier. The three command endpoints remain DRAFT and unmounted on the service side. Unit command tests use an explicit HTTP fixture server, not a C implementation. The real boundary test covers wallet/history against PostgreSQL and confirms unmounted command endpoints remain unknown; it does not prove durable create/cancel/recovery.

Before active cutover, B/C must review these signatures and the [draft intent contract](../contracts/payment-intents.openapi.json), implement mutation wrappers and real tokens, and test positive/replay/lost-reply/cancel-fence cases with the actual service. E integrates Pact/Compose/gateway and D retries/fault evidence.

A still needs to switch the existing Booking/API/UI callers and migrate data only after their corresponding writers/auth/events are ready. Completion/refund/wallet provisioning remain trusted event/business hooks described in [Payments business handoff](payments-business-handoff.md); no new HTTP routes for them are invented here. Existing callers are listed in [extraction inventory](extraction-inventory.md), including provider registration, completion/cancellation and Server Components. Read preparation does not authorize switching reads while writes still land only in SQLite.

Recorded checks: [adapter validation](validation/payment-adapters-2026-11-06.md).
