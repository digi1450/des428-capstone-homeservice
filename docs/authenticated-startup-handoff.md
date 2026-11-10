# A authenticated startup and compiled Next acceptance

10 November 2026; builds on merged PR52. Instrumentation now calls `startApplication()`.
Legacy startup remains the default. No deployed environment, routing, useful data or
shared Compose flags are enabled by this change.

## Explicit deployment selection

Keep `AUTHENTICATED_SERVICES_ENABLED=false` until the following configuration and
identity/data/worker acceptance are reviewed. The second gate is deliberately a
separate deployment acknowledgement, not a substitute for those checks:

- `AUTHENTICATED_SERVICES_ENABLED=true`
- `AUTHENTICATED_CUTOVER_APPROVED=true`
- `OIDC_LOGIN_ENABLED=true`; `AREA_B_NOTIFICATIONS_PROXY` and `AREA_B_PAYMENTS_PROXY`
  must stay false. Receiving services separately require B's real verifier wiring.
- Exact trusted HTTPS `KEYCLOAK_ISSUER`, HTTPS service origins
  `PAYMENTS_WALLET_SERVICE_URL` and `NOTIFICATIONS_SERVICE_URL`.
- `OIDC_REDIRECT_URI` is the exact HTTPS `/api/auth/keycloak/callback` URL registered
  in the realm, with correct externally visible origin at the Next server.
- Booking `BOOKING_SERVICE_CLIENT_SECRET`, B `OIDC_SESSION_SECRET`, persistent
  `IDENTITY_MAPPING_DB_PATH` and `OIDC_SESSION_DB_PATH` (fallback mapping sidecar).
  Neither sidecar may use the Booking database path. Mount durable writable storage;
  preserve keys and mappings across restarts. Supply CA trust, never disable TLS.
- `AMQP_URL` and the reviewed C/E topology, service relays/consumers and readiness.

These variables are documented in root `.env.example`; root Compose does not
inject this new selection automatically. There is no account migration, new-user
Keycloak provisioning or automatic configuration/secret generation here.

## Boot and lifecycle

1. Validate explicit mode/configuration gates. Reject already-owned broker workers.
2. Run the existing non-destructive SQLite bootstrap. Invalid schema terminates
   startup before any workers; no database reset is introduced.
3. Authenticated mode selects PR52's identity/clients/saga/finalization/event writers
   before any relay starts. Legacy mode retains the original local relay.
4. Start existing C subscription supervisors, then broker relay, then the SINGLE
   authenticated recovery scheduler. Starting a supervisor is asynchronous and
   does **not** prove RabbitMQ topology/subscriptions or end-to-end readiness.
5. Concurrent/repeated boot calls share one pending/completed process handle.
   A boot failure clears only its owned selections/workers, with no legacy fallback.
   Next14 can continue after a rejected instrumentation hook, so instrumentation
   explicitly exits on boot failure, logging no raw configuration/credential error.

A host that owns HTTP lifecycle may `await handle.stop()` AFTER draining HTTP.
No new signal handler competes with Next's shutdown handling. A process kill may
interrupt attempts; C's durable work and leases remain responsible for recovery.

`processState` shares the nine runtime selections between instrumentation, API and
RSC bundles inside **one Node process**. It does not share users or state between
requests/processes; each process boots its own runtime. The nominal AppError base
is also process-owned so an instrumentation callback's typed 401/503 is recognized
by a route bundle without accepting arbitrary objects with `statusCode` fields.

## Observed tests and remaining gates

See [dated validation](validation/a-authenticated-startup-2026-11-10.md).
The compiled production Next test now exercises actual API and RSC requests,
fixture persisted OIDC identity and a locally trusted HTTPS Payments fixture.
It proves current-request credential resolution across Next bundles, rejection
of a valid legacy JWT cookie, remote pending-wallet rendering, proper 503 on
remote outage, proper 401 on removed identity mapping, and process exit when
the cutover acknowledgement is missing.

It is **not real Keycloak login/refresh/ID-token issuance**, not real Payments JWT
verification/ledger effects, and not RabbitMQ delivery. The broker URL is an
intentionally unavailable loopback fixture; reconnecting supervisors are not
final readiness. PR52's separate signed-issuer/real-PostgreSQL boundary continues
in CI. Actual Keycloak/browser provisioning, persistent deployment volumes/TLS,
full financial/event/notification flows, D failures/concurrency, E tracing/resource
budget and legacy eligibility/checkpoint/cutover still need integrated acceptance.

Run after locked monolith install and `npm run build --prefix bangkok-homeservice`:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/fixture-key.pem \
  -out /tmp/fixture-cert.pem -days 1 -subj /CN=localhost \
  -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost'
cd bangkok-homeservice
node ../scripts/verify-next-authenticated-startup.mjs /tmp/fixture-key.pem /tmp/fixture-cert.pem
```

Use a disposable Linux checkout with native dependencies. Ports3199 and an ephemeral
HTTPS listener are local test listeners; no fixture certificate/key belongs in Git.
