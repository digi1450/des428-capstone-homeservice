# A step 4 — Payments and Booking runtime composition

Recorded 8 November 2026 against main `b96a92d` (#36). This slice connects A's HTTP/callers with C's real participant, eligibility, outbox, readiness and recovery. It does not complete step 4, implement B's missing JWT verifier, activate live monolith traffic or perform step 5/data cutover.

## Payments process

`services/payments-wallet/src/runtime.js` exports:

```js
const {app, business, participant} = createPaymentsRuntime({
  database,             // Payments' owning pool/transaction boundary
  authenticate,         // B: verified end-user -> {role, domainId}
  authenticateService,  // B: verified service/operation -> {service:'booking', callerId}
});
```

It constructs the business primitives, C participant and settlement hooks together. Eligibility delegates to that participant under the existing order lock; `stageEvent` calls C's outbox with the same transaction client. No business table is shared across databases and no remote call is added inside a transaction.

Both verifier callbacks must be supplied together, or both omitted. Supplied-but-incomplete configuration throws before serving; omitted configuration leaves both protected boundaries returning 503. Presence of a callback is not proof of real JWT verification: B must supply signature/issuer/expiry/audience/permission/identity validation. No decoded-claim/header/token fixture fallback is installed.

`src/server.js` now uses this factory instead of calling the bare app with no participant/hooks. It still supplies no B verifier, so actual protected HTTP remains unavailable by default. A will import/inject B's reviewed callbacks there when delivered. Health/readiness keeps its existing database-oriented meaning; it is not evidence that authentication or final business integration is complete.

`request-context.js` retains only the sanitized request ID in AsyncLocalStorage. At event staging it captures the active OTel carrier and passes allow-listed trace/request/correlation fields to C. With E's OTel preload this connects HTTP -> durable outbox -> E's relay/consumer spans. It stores no bearer token, request body or actor object. Calls outside an HTTP scope may have no request ID. No fake trace is synthesized from a raw header if OTel has not established an active context.

## Booking/caller composition

`bangkok-homeservice/lib/modules/booking/payment-runtime.js` exports:

```js
const runtime = configureBookingPaymentsRuntime({
  paymentsClient,
  serviceCredentials, // B's service-caller provider, used by the command adapter
  userCredentials,    // B's verified delegated customer/provider credentials
  sagaOptions,        // optional positive existing C options; D still owns final policy
  recoveryIntervalMs: 2000,
});
runtime.startRecovery(); // explicit; never auto-started by construction
// Shutdown: drain HTTP callers first, then:
await runtime.stop();
```

The complete client and both credential callbacks are validated before global configuration changes. The factory rejects replacing an already configured saga/access pair. It configures the real Booking adapter and C saga, and sets the existing caller seam's `readSetup` directly to C's `paymentSetupFor`; no readiness test double/new store is involved. Missing, pending, blocked or reconcile still cannot enable payment in A's views.

The opt-in scheduler calls C's `recoverOnce`; C retains its durable keys, claim fencing, workflow decisions and persisted backoff. This scheduler does not overlap its own rounds, is idempotent on repeated start, and stops scheduling/awaits its in-flight round before clearing the configuration it owns. Callers must drain HTTP before stopping it. Do not also start the legacy `startSagaRecovery` scheduler or run independent configure/reset helpers against this runtime. The 2000 ms default is C's existing engineering interval, not a measured SLA or D-approved retry policy.

B's existing `configureSecureBookingPayments` helper accepts optional `userCredentials`, `sagaOptions` and `recoveryIntervalMs`. Supplying `userCredentials` selects this combined composition and returns the lifecycle object above. Omitting it preserves B's existing saga-only helper behavior; it does not silently create end-user credentials. Final startup should use the combined path once B supplies verified user delegation, then explicitly start recovery.

No call is added to `instrumentation.js`: real B callbacks/credentials and final coordinated process wiring are still missing. No environment switch can turn this on with fake roles. Existing non-saga legacy flows remain until cutover; configuring remote access still forbids old gateway placement without a saga and saga-owned requests never fall back to SQLite intent/simulation. Existing registration/completion/refund/notification local writers have not been retired by this slice.

## Validation actually run

- Node 20 monolith suite: **184 passed, 0 failed/cancelled/skipped**. New tests cover incomplete configuration without partial state, separate credential callbacks, real readiness, replacement rejection, no automatic worker, no overlapping rounds, stop/drain behavior and B helper compatibility.
- Node 22 + PostgreSQL 16 Payments suite: **90 passed, 0 failed/skipped**. New factory HTTP tests cover default 503 without SQL, incomplete verifier rejection, actual C create/replay/activation eligibility, and one charge/outbox on replay. Injecting an outbox-write failure rolls back the intent transition, charge and webhook receipt. A deliberately instrumented test HTTP span is persisted with the request/correlation ID; auth is an explicit test double.
- Notifications suite **42 passed** and C consumer lifecycle **5 passed** against disposable RabbitMQ 4.1; no skips. Notifications code was not changed.
- New `tests/integration/a-payment-runtime-boundary.test.mjs`: **6 passed, 0 failed/skipped**. Next route -> composed adapter/client -> real HTTP -> composed C participant -> PG, with actual C readiness/recovery. The first activation commits but its caller sees an explicit simulated lost reply; UI remains pending and slots stay held. Recovery retries the same saved key, becomes ready, and repeated payment leaves one charge/outbox. Its fixture drops local intent/wallet tables to prove no SQLite fallback. Paid-event delivery is deliberately not consumed; wallet stays pending until provisioning. Stopping composition makes saga-owned operations unavailable safely.
- Ordered Pact consumer/provider runs: **2 + 2 passed**, with disposable provider databases and auth doubles. Existing read contracts remain compatible.
- Production standalone Next Docker build passed; `git diff --check` and document-link checks passed.

The worker test keeps a bounded test deadline referenced while waiting for an intentionally unreferenced background timer; the initial unbounded fixture wait was corrected before the full pass. Tests never use useful data. All PG/Rabbit checks run in dedicated tmpfs projects without host ports; Pact cleanup removes only its own disposable resources. No existing stack is started/stopped. No schema, dependency, real credential or migration data change is made.

To reproduce with installed dependencies and explicit disposable database/broker URLs:

```sh
npm test --prefix bangkok-homeservice
npm test --prefix services/payments-wallet
node --test tests/integration/a-payment-runtime-boundary.test.mjs
docker compose -f docker-compose.pact.yml run --rm --build pact-tests
```

The new boundary requires `TEST_DATABASE_URL` pointing to a disposable Payments database and monolith native dependencies compiled for its Node version. Without the URL it skips; that is not the recorded full result. Service SQL/MQ tests also need their documented test URLs.

## Remaining acceptance gates

1. B delivers real verifiers, service identity/permissions and delegated end-user credentials for API and Server Components; A injects them into the composed entrypoints.
2. A/C/E enable the reviewed monolith startup and one recovery strategy, wallet consumer/broker processes and migration readiness in the final stack. Validate actual Keycloak auth, restart/compensation/duplicates with D's supplied policy.
3. A/E verify real HTTP writer context -> outbox -> relay -> consumer in Jaeger, rather than inferring the entire live flow from this fixture.
4. Complete remaining caller/writer transitions and A/C legacy eligibility/importer review before freeze/backup/import/routing cutover. No imported legacy intent is automatically activated here.

Step 4 is partially implemented by this PR; it remains open as a project milestone until real auth, processes and end-to-end acceptance are complete. See [current status](project-status.md), [caller handoff](payment-setup-callers-handoff.md), [E tracing](e-cross-service-tracing-handoff.md), [C saga](c-saga-handoff.md) and [data/cutover](data-cutover-handoff.md).
