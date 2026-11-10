# A authenticated runtime validation — 10 November 2026

Base: main d1ef13c after PR51. Code is staged explicit composition; no production
startup, useful database, gateway route or auth/cutover flag is changed.

Observed locally in disposable cached Node20/Linux containers:

- Full monolith:273 passed, zero failed/skipped, including the new composition
  family (6 child cases plus parent). Existing legacy-mode tests remain green.
- Actual A/B/C HTTP/two-PostgreSQL16 boundary:7 passed, zero failed/skipped (6 child
  cases plus parent). Real RS256 verification with fixture issuance/JWKS, owning
  monolith mapping/session SQLite and actual service HTTP/PG. No real Keycloak,
  TLS, browser HTML acceptance or AMQP delivery is implied.
- Production Next build passed with a temporary container-only SQLite path.
- git diff --check passed. CI validates the pushed head separately.

The boundary proves API/page-context Notifications ownership, blocked cross-owner
mark-read, provider pending wallet projections, service-authenticated create and
activate, user-authenticated payment, provider OTP completion and one charge/payout,
original-bearer webhook isolation, and autonomous cancellation recovery after a
Payments listener outage. Separately issued Booking tokens retain the same caller
and saved cancellation key. It drops local financial/inbox tables only inside its
throwaway SQLite fixture to detect accidental fallback.

The POST Booking response intentionally retains pending even when immediate
activation succeeds; detail then reads real readiness. The first fixture wrongly
expected immediate ready and tried booking11:00 overlapping the seeded90-minute
service at10:00. Corrected assertions use the established POST/detail contract,
13:00 for the next booking, and the actual reserved-slot count. No production
behavior was changed to satisfy those fixture assumptions.

A controlled financial-delivery fixture additionally verifies concurrent recovery
calls share one round and shutdown waits for the in-flight result before clearing
owned runtimes. No new retry loop or command identity is introduced.

Integration Notes rows are seeded through the owning service; they are not effects
shown delivered by Booking. Real payment.succeeded remains in PG outbox and local
paid stays pending because the broker/consumer is deliberately not started.
Fixture identity resolution calls the monolith-owned mapping; production trusted
resolver HTTPS and final consumer/process wiring still need A/B/C/E acceptance.

Commands (three locked package dependencies required for integration):

```sh
npm test --prefix bangkok-homeservice
TEST_AUTH_PAYMENTS_DATABASE_URL=<disposable-payments-pg> \
TEST_AUTH_NOTIFICATIONS_DATABASE_URL=<disposable-notifications-pg> \
node --test tests/integration/authenticated-services-boundary.test.mjs
npm run build --prefix bangkok-homeservice
```

Local tests used the dedicated project homeservice-a-auth-runtime, two tmpfs PG16
containers with no host ports, and cached images with clean Linux dependencies.
Only that project's resources were stopped/deleted after checks. No host native
SQLite load, dependency installation, Gatekeeper bypass or useful data reset.
