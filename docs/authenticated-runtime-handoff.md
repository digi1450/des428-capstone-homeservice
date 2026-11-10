# A authenticated service composition — staged integration

10 November 2026; based on main d1ef13c after B PR51. This connects the merged
A/B/C interfaces in one explicit composition. It does not enable default startup,
change useful data, select gateway routes, or establish live Keycloak/cutover.

## One explicit runtime

`bangkok-homeservice/lib/runtime/authenticated-services.js` exports:

```js
const runtime=configureAuthenticatedServices({
  issuer,                    // exact trusted HTTPS Keycloak /realms/<realm>
  paymentsUrl,notificationsUrl, // trusted HTTPS service origins
  bookingClientSecret,       // B booking-service client; never a browser secret
  sessionSecret,sessionDbPath,identityMappingDbPath, // same B configuration as login/refresh
  recoveryIntervalMs:2000,
  sagaOptions:{},finalizationOptions:{}, // reviewed existing C/D positive-integer options
});
runtime.startRecovery();      // only after coordinated boot/configuration gates
await runtime.recoverNow();   // optional one round, coalesces with this runtime's in-flight round
// Stop accepting and DRAIN HTTP before teardown. No outage fallback to legacy.
await runtime.stop();
```

PR52 originally had no call in instrumentation. The subsequent [startup handoff](authenticated-startup-handoff.md) adds an explicitly gated call; both gates remain false by default. The lifecycle below still applies.
A/E must wire this **after successful SQLite bootstrap but before legacy relay or
other recovery timers start**, after the gates below. Starting the legacy relay
or C standalone saga-recovery timer first makes construction fail rather than
quietly running two schedulers or stopping someone else's timer.

The factory validates configuration, B sidecars and clients, rejects replacement,
then composes:

- Existing A Booking/Payments client + C provisioning/activation saga/readiness.
- C financial finalization callbacks/work/guards using A financial client and the
  SAME B service-credential provider as provisioning (no duplicate A command store).
- Notifications and Payments end-user clients using a freshly read B server session.
- Provider event-only wallet/approval writes and notification event delivery.
  Local notification relay dispatch is disabled; C broker/ratings/wallet processes
  must be ready before traffic. Durable events remain pending during outages.
- Original webhook bearer passthrough to Payments' separate B gateway verifier.
  No gateway token is minted for an untrusted incoming callback. Simulation uses
  the existing customer-authorized Payments endpoint and its settlement gate.
- Shared OIDC identity selection for monolith route handlers and Server Components.
  Identity mapping is rechecked locally through B's owned sidecar before local
  Booking operations; stale/deleted bindings fail closed.

Configuration rollback clears only this factory's selections. Stopping/draining
waits for this runtime's recovery round, then clears only still-owned state.
There is no automatic reset to SQLite after service/auth/broker failure.

## Request, page and recovery credentials

Selected request identity is `{sub:<legacy integer>,role,email}` derived from B's
persisted session plus the CURRENT owned mapping/profile. Existing APIs use it
through `getAuth`; pages/layout use it through `getSession`. Roles and IDs in
browser bodies/headers or the old `edemand_token` cannot replace that identity.

The selected browser/monolith flow uses B's opaque session cookie. This slice does
not add direct Keycloak-Bearer authentication to monolith endpoints; direct service
APIs already validate Keycloak Bearer tokens. Review any non-browser API clients
before rollout. Legacy mode remains unchanged when no composition is selected.

End-user credentials check the requested actor against the CURRENT request's
session and exact destination audience. Explicit API Request context wins; a
missing context resolves `next/headers` at call time for Server Components. It
never captures a browser user's token at startup or reuses one user's identity for
another request. Request/trace metadata is allow-listed, not authorization input.
Tests inject a page-request provider; actual production page-context acceptance
still needs the coordinated Next/Keycloak deployment.

Recovery gets Booking service credentials with NO browser context. One opt-in,
non-overlapping scheduler runs C provisioning/activation and financial recovery;
C owns persisted keys, attempts, backoff, leases and compensation. The earlier
Booking-only scheduler is not started alongside it. Recovery retries do not
mint command identities or perform SQL across service databases.

Existing customer/provider/admin login URLs redirect to B's PKCE start route only
when this composition is selected. The original logout URL delegates to the same
B session revocation implementation with the configured sidecar/secret; it does
not merely clear the old legacy cookie. Login/refresh configuration must match
this runtime's issuer/session paths/secret. This is not Keycloak global logout.

## Gates before activation

1. A/B validate real realm roles/audiences, existing and new account provisioning,
   browser login/refresh and actual API/Server Component identity. Signup-to-Keycloak
   provisioning is still B/A work; do not infer it from an existing mapping CLI.
2. B/E provide trusted HTTPS names and CA trust INSIDE containers, Booking secret,
   gateway credentials for the actual mock callback issuer, protected persistent
   identity/session sidecars and safe secret lifecycle.
3. Keep B proxy-only flags off when using this integrated selection; use these
   shared A callers consistently. Set B OIDC login and receiving-service auth
   configuration only as part of the reviewed integration deployment.
4. A/C/E must review legacy eligibility, source freeze/checkpoint/migration and
   message watermark before moving useful traffic. All financial/inbox readers
   and writers switch together. Imported intents are not automatically activated.
5. E wires monolith broker relay/payment/rating consumers, Payments outbox relay,
   Notifications and wallet consumers and readiness/migrations. D/C exercise real
   faults/concurrency; E verifies traces/Pact/resource budget/clean-clone boot.

Observed local validation: full monolith273 and authenticated boundary7 passed with zero skips; production build passed. See [dated evidence](validation/a-authenticated-runtime-2026-11-10.md).

## Validation boundaries

- New composition tests cover configuration/rollback/replacement, actor binding,
  API/page-context consistency, no legacy fallback, current mapping invalidation,
  webhook confused-deputy prevention, revoking the selected sidecar session and
  idempotent recovery shutdown.
- The actual HTTP/two-PG test uses real B RS256/JWKS verifiers, mapping/session
  sidecars, A clients/public route handlers and C provisioning/finalization.
  It checks Notifications ownership and wallet pending through API/page-style
  calls, charge/payout exactly once, actual gateway JWT isolation, and autonomous
  cancellation recovery across a Payments listener outage with separately issued
  tokens retaining one caller/key. Local financial/inbox tables are dropped in
  its disposable SQLite fixture to prove no fallback.
- Keycloak token issuance/JWKS, HTTPS transport and the identity lookup transport
  are explicit fixtures. Notes are seeded owning-service fixtures, not effects
  proved delivered from Booking. The test leaves payment.succeeded in real PG
  outbox and confirms local paid remains pending: no AMQP consumer is running.
  Do not claim full business notification/paid-event delivery or live TLS/realm.
- CI runs this boundary in its own job with two disposable PostgreSQL16 databases;
  it does not share financial rows/wallet fixtures with older boundary suites.

To run the boundary after installing the three locked package dependencies:

```sh
TEST_AUTH_PAYMENTS_DATABASE_URL=<disposable-payments-pg> \
TEST_AUTH_NOTIFICATIONS_DATABASE_URL=<disposable-notifications-pg> \
node --test tests/integration/authenticated-services-boundary.test.mjs
```

Both environment variables are required; an omitted URL skips, not a pass.
