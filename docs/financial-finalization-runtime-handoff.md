# Step 5C — A financial HTTP, client and callers

9 November 2026; extends the v1.0.0 [contract](financial-finalization-contract-handoff.md)
and [lead-selected baseline](financial-finalization-decisions.md), based on main
`7cbec6a`. This is A's prepared implementation, not completed financial cutover.
No production selector, schema, useful data, credentials or gateway route changed.

## Payments HTTP and ownership

`services/payments-wallet/src/financial-router.js` mounts these routes before the
existing end-user `/api` router:

- POST `/internal/booking-completions`: `complete_financial`, saved `complete:<UUID>`.
- POST `/internal/booking-cancellations`: `cancel_financial`, saved `cancel:<UUID>`.
- GET `/internal/financial-operations/{command_id}`: `query_financial`.
- POST `/api/payments/webhook`: distinct `settle_webhook` mock-gateway verifier.

`financial-validation.js` belongs to the service: strict fields, IDs/money, COD vs
gateway provisioning, key/operation identity, full original request echo,
accounting arithmetic and ready/pending/attention unions. JSON is bounded to
16 KiB. Malformed/missing C output cannot become success. Only reviewed conflict
codes are serialized; a financial conflict is not a safe refund/fence result.

`createPaymentsRuntime` accepts optional `authenticateWebhook` and
`createFinancialOperations({database,business,participant,outbox})`. The latter
must return C's complete/cancel/get interface from the exact contract; incomplete
factories fail at construction. Missing financial participant or verifier means
503. The existing service/user verifier pair remains required together when
supplied. Default `server.js` supplies no new verifier or financial factory.

There is **no new A-owned command table, financial worker or recovery strategy**.
C owns atomic command/result/fence/dedupe and existing per-order lock semantics,
including race-safe payout/refund eligibility. C must also wire those new fences
into the settlement hooks; HTTP validation alone cannot prevent settlement races.

The callback delegates to Payments' existing `settleWebhook` business primitive
and real C provisioning settlement gate/outbox hooks. It authenticates before
parsing and never accepts an end-user/Booking principal or legacy shared-secret
fallback. B must implement actual signature/issuer/expiry/audience/permission
verification, stable caller mapping and callback credential provisioning.

## Monolith client and Booking interface

`payments/financial-client.js` exports `createFinancialClient`. Its methods are:

```js
client.complete({commandId, request}, serviceCredentials);
client.cancel({commandId, request}, serviceCredentials);
client.getOperation({kind, commandId, request}, serviceCredentials);
client.settleWebhook(callback, gatewayCredentials);
```

The client validates the saved snapshot, preserves supplied keys and metadata,
rejects redirects, bounds response bytes and covers headers/body with one timeout.
It performs no automatic retry, command generation, SQL or fallback. C's durable
worker retries/query-checks the same original work. Unknown outcomes use
`FinancialOutcomeUnknownError`; coded/uncoded/malformed 409 conflicts use
`FinancialReconciliationError`, while validated attention is returned as such.
Auth rejection remains 401/403. GET 200 is not automatically ready.

`booking/financial-access.js` exposes:

```js
configureBookingFinancialAccess({bookingFinalization: {
  complete({orderId, providerId, otp, context}),
  cancel({orderId, customerId, context}),
  status({orderId, context}),
  assertTransitionAllowed({orderId, operation}),
}});
```

These are **C-owned callbacks**, not new A workflow implementations:

- Complete returns the persisted flat completed public order plus
  `accounting_status: pending|ready|attention`. C must atomically recheck
  owner/OTP/legal state and commit Booking+durable work, then recover accounting.
- Cancel returns the v1 public pending/attention/ready projection. C persists one
  operation per accepted logical cancellation, retains holds while pending or in
  attention, and releases them only with a confirmed safe Payments result.
- Status returns applicable `accounting_status`/`cancellation_status` fields.
  A validates them against Booking state; missing completed accounting or invalid/
  unavailable status stays conservatively pending, never a guessed ready result.
- `assertTransitionAllowed` is **synchronous**, executes inside the existing
  SQLite confirm/start/reschedule transaction, and returns exactly `true` only
  if C's local pending/attention work permits the transition. Promise guards fail
  closed. C must perform equivalent guards within its completion/cancel atomic
  work transaction; A's earlier ownership/OTP checks cannot replace that recheck.

All four callbacks are required and replacing an active configuration is rejected.
Reset helpers are for tests/drained shutdown, never outage fallback. Context may
include the public request for B delegation; do not persist/log credentials.
A also checks the returned public order against actual current Booking data;
unpersisted success or malformed projections return 503. No financial success is
inferred from a completed Booking response while accounting remains pending.

`configureWebhookAccess({financialClient,credentials})` selects the monolith's
forwarding path; B's credentials callback must verify the incoming mock gateway
request and obtain the reviewed delegated gateway credential. It must not mint
an authority merely because an arbitrary request arrived. Completion/cancel
wrappers, wallet/history access and the legacy settlement helper fail closed
rather than use SQLite after remote financial ownership is selected. Existing
saga-owned orders also cannot use legacy completion/cancellation/settlement.

## Public API and UI

Default legacy flow remains compatible. In coordinated financial mode:

- Completion accepts strict numeric six-digit OTP; returns 200 after C confirms
  persisted completion/work, showing pending/attention accounting when applicable.
- Cancellation accepts no body or `{}`; 202/409 retains the current order and
  hold, while 200 terminal cancellation includes the confirmed refund outcome.
- Detail and provider list display financial pending/attention. Cancel/conflicting
  transition buttons and simulation are guarded while cancellation is pending;
  Payments/C transaction checks remain authoritative, not the UI.
- A persisted cancellation-attention response refreshes the UI to show its state;
  it is not treated as successful refund. No background polling is introduced. Existing custom-job ending times such as
  `24:00`/`25:00` are preserved in schemas and runtime projections; no date wrapping
  or change to Booking/Bidding scheduling is introduced.

Do not select the new mode piecemeal in production. Compose the C work/runtime,
B user/service/gateway credentials, #40 reader/#41 writer/#42 relay changes,
existing provisioning recovery, message consumers and final data/routing gates.
The optional seams are preparation, not instructions to enable traffic now.

## Observed validation and limits

Dedicated disposable PostgreSQL 16/RabbitMQ 4.1 containers, no host ports, synthetic
rows only. No unrelated stack or useful database was stopped or migrated.

- Monolith **214 passed**, Node 20: inherited flows and new client/caller validation,
  pending/attention holds, synchronous transaction guards, no moved-table fallback.
- Payments **100 passed**, Node 22, PG/MQ enabled: HTTP validation/status/error/auth
  separation plus existing business/provisioning tests. New actual HTTP callback
  tests exercise real C activation/eligibility, PG receipt/charge/outbox, replay
  and conflicting event identity. Credentials are explicit fixture verifiers.
- New `tests/integration/financial-finalization-boundary.test.mjs`: **4 passed**,
  A client -> Express -> injected completion/cancel fixture, and callback -> real C
  provisioning/eligibility -> PG. The financial participant fixture has **no
  durable command/result or money effect**, so this does not prove C completion,
  refund/fence/recovery/races or real authentication.
- Production standalone Next build passed. Static contract suite **30 passed**;
  ordered existing read Pact **2 consumer + 2 provider passed**, in that order.
  Financial HTTP tests are separate from those read Pacts, and do not constitute
  new financial Pact consumer/provider coverage.

Reproduce with locked installed dependencies and disposable test URLs:

```sh
npm test --prefix contracts
npm test --prefix bangkok-homeservice
TEST_DATABASE_URL=... TEST_AMQP_URL=... npm test --prefix services/payments-wallet
TEST_DATABASE_URL=... node --test tests/integration/financial-finalization-boundary.test.mjs
```

Do not point test variables at useful databases. Integration tests skip without
`TEST_DATABASE_URL`; a skip is not the recorded pass. CI also runs the new
monolith/financial boundary job with its own PostgreSQL and fixture auth.

## Remaining handoffs

1. **C:** implement durable financial operations and Booking callbacks, sync local
   guards, completion/cancellation work identity, recovery/attention and race-safe
   financial settlement/fence/payout/refund. No double store or new key per retry.
2. **B:** actual financial operation permissions/service identity, verified user
   delegation and distinct mock-gateway callback verification/credentials.
3. **A/C:** integrate actual callbacks/factories, rerun end-to-end failure/restart/
   duplicate/settle-cancel races, review new schemas against importer and exact
   preserved SQLite startup. A's prepared code is not evidence those tasks pass.
4. **D/E:** fault policy/tests, final process/auth wiring, new financial Pact
   coverage, real Jaeger flow and combined resource evidence.
5. **A step 5D:** legacy intent eligibility/binding, freeze/backup/import/checkpoint
   rehearsal and routing/read-write cutover. Do not fabricate historical command
   keys/fences or activate imported intents to satisfy the new contract.
