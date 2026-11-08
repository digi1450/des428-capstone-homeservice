# A step 3 — payment setup and caller preparation

> Step 4 update: [runtime composition](payment-runtime-composition-handoff.md) now assembles C hooks and real readiness behind the B auth/explicit startup gate; earlier uncomposed-startup statements below describe the prior slice.

Recorded 8 November 2026, based on merged #33 (`7ef0f08`). This prepares UI and caller integration; **it does not enable live service ownership or production saga/recovery**. Default startup is unchanged. A owns HTTP/callers/UI; C owns durable activation/recovery, command/fence/eligibility and messaging; B owns verified identity/credentials.

## Available boundaries

Payments adds authenticated, owner-scoped `GET /api/booking-payment-intents/:order_id` and customer-only `POST /api/payments/simulate` with strict `{order_id}` JSON (16 KiB limit). Simulation uses the existing business transaction and requires C's `assertSettlementAllowed` and same-transaction `stageEvent` hooks. A UI flag cannot bypass eligibility. No public webhook/completion/refund routes are enabled by this change. See `contracts/payments-reads.openapi.json` v0.2 and the strict monolith client methods `getIntentForOrder` and `simulateSucceeded`.

A missing wallet now returns `wallet_setup:'pending'`, null balances and any existing charge/refund history. It is not a confirmed zero wallet. Wallet-affecting ledger entries without a wallet cause 503/reconciliation. A real wallet preserves the existing numeric response shape, balances and history; reads never provision a wallet. The wallet/history contract and client validate this union. Pages render null balances as a dash and explain pending provisioning.

Next API handlers and Server Components use `lib/modules/booking/payment-view.js` and `lib/modules/payments/access.js`:

- Booking detail authorizes the local order first. Remote intent order/amount must match Booking; no provider sees the customer OTP. An unavailable/missing intent leaves the booking visible with `payment_setup:'pending'`.
- `payment_setup:'ready'` requires a successful explicit authoritative readiness callback; an existing intent or a historical create response is insufficient. Pending, blocked, reconcile, unknown or a callback error are publicly pending. A newly created/replayed saga 201 response is conservatively pending; GET detail is the current readiness check.
- New-booking and detail UI share a payment widget. Pending disables simulation; a user can check status again. A succeeded remote intent is displayed as paid even before the Booking paid event arrives; this is a display projection, not a SQLite write. A later refund takes precedence over historical intent success in both the detail label and shared widget; cancelled bookings do not infer paid from intent success.
- The simulate API also checks local ownership/readiness; Payments then checks its transactional eligibility/fence. Timeout/failure never marks payment successful or releases slots. Repeated simulation reaches the existing single-charge guard.
- Saga-owned bookings never read an old SQLite intent or use local simulation, even before access is configured. Configured remote access also forbids legacy gateway placement unless the Booking saga is configured, before any slot/intent write. Legacy behavior remains the default only for non-saga bookings while no access is configured. This compatibility path is temporary, not final extraction.

## Explicit integration seam — not startup instructions

```js
configurePaymentsAccess({
  paymentsClient,
  credentials: verifiedEndUserCredentials,
  readSetup: authoritativeBookingPaymentReadiness,
});
```

The client must implement intent read, simulation, wallet and customer-history methods. `credentials(auth, context)` must obtain B-verified delegated **end-user** credentials usable from HTTP and Server Components. A Booking service token is not a replacement for customer/provider identity. No raw identity header, browser-supplied role, secret in the UI or fallback token is provided here. This callback is distinct from the service-token provider used by the Booking command adapter.

`readSetup(orderId)` must use C's durable activation outcome; only its exact `'ready'` return enables payment. This branch deliberately does not read a proposed/unmerged activation table or manufacture a new readiness store. C's corrected recovery/migration must be reviewed and integrated first. The callback's local hint is never settlement authority.

Payments composition separately needs B's `authenticate`/`authenticateService`, C's command participant and business `paymentHooks`. `src/server.js` still injects none of them, so protected business HTTP fails closed by default. Do not copy test auth/readiness doubles into production. There is no automatic environment flag activating these callers.

## Validation actually run

- Node 20 Docker monolith suite: **161 passed, 0 failed/skipped**. New tests cover unchanged legacy behavior, saga-owned pending without access, remote reads/simulation with the local intent table removed, pending/reconcile/blocked/cancelled states, owner checks before remote calls, wallet/history without the local wallet table, mismatched owner/context, rejection before old gateway writes, and a real legacy pay → cancel/refund regression.
- Node 22 + isolated PostgreSQL 16 Payments suite: **69 passed, 0 failed/skipped**. Real HTTP cases cover owner checks, input/media/size handling, missing hooks, pending wallet/history, preserving a real balance and settlement before/after actual C activation with one charge/outbox effect.
- Existing real HTTP/PG payment boundary suites: **9 passed, 0 failed/skipped**.
- New `tests/integration/payment-views-boundary.test.mjs`: **5 passed, 0 failed/skipped**, running Node 20 Next route modules → actual client/adapter → Express → real C participant/business hooks → PG16. After gateway creation the test drops its fixture SQLite intent/wallet tables. Pending blocks payment, a deliberately stale ready callback cannot charge before PG activation, actual activation permits one charge, repeat cannot double-charge, remote succeeded intent is visible before paid-event consumption, and wallet pending retains history until real provisioning.
- Contracts: **19 passed** including OpenAPI parsing and pending-wallet shape checks. Production standalone Next Docker build passed. `git diff --check` passed.

For the service/boundary tests set `TEST_DATABASE_URL` to a **disposable** Payments database and install the service's dependencies. The new caller integration additionally needs the monolith's native SQLite dependency compiled for its Node runtime (the recorded run used Node 20). Run from repository root:

```sh
node --test tests/integration/payment-views-boundary.test.mjs
```

The service suite is `npm test` in `services/payments-wallet`; the monolith suite is `npm test` in `bangkok-homeservice`; contract tests are `npm test` in `contracts`. PostgreSQL-backed cases skip without the explicit test URL; a skipped run is not the evidence recorded above.

Runs used source copies/read-only mounts and separate PG16 tmpfs projects with no published ports, removed afterward. No useful database, broker, actual credential or other project was touched. Auth and readiness are test doubles. No live Keycloak, RabbitMQ delivery, C activation worker, browser interaction, Pact, cross-service tracing, full-stack resource budget or live migration is established by these checks.

## Next integration and remaining A work

1. Review B's actual JWT/domain identity/delegation delivery and C's corrected activation/recovery and wallet-consumer deliveries. Compose the explicit seams, including Server Component credentials; verify real auth, readiness/restarts and duplicates together.
2. Finish provider-registration wallet writer, Notifications callers/writers, completion/refund/webhook transitions and event-driven Booking paid state. These existing local writers are not retired in this branch. Do not enable mixed ownership by simply setting access/gateway routing.
3. Agree legacy unpaid-intent eligibility and reconcile/importer compatibility against final schemas; freeze/backup/migrate/reconcile and coordinate all callers plus nginx only after acceptance. No legacy intent is automatically activated here.

See [current status](project-status.md), [caller inventory](extraction-inventory.md), [data/cutover runbook](data-cutover-handoff.md), [activation client](payment-activation-client-handoff.md) and [A/C decisions](payment-participant-decisions.md). Step 3 preparation does not mean Area A or the assignment is complete.
