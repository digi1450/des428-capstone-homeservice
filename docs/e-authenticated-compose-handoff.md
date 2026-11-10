# E authenticated Compose integration

Based on main after PR53, 10 November 2026. This prepares a reproducible **local,
disposable integration deployment**, not an approved migration of useful data.
Default startup/cutover/auth flags remain false. Existing base gateway traffic stays
with Next. The browser uses the monolith's opaque session; do not mount the old
candidate routes to send cookie-authenticated requests straight to Bearer services.

## What is wired

- Base Compose now includes the Payments wallet consumer (13 services). All three
  workers wait for their owning HTTP service's migration readiness and RabbitMQ.
- Worker health is actual current subscription/publisher connectivity AND owning
  migration readiness. Broker cancel/disconnect or DB failure makes it 503, then
  returns 200 on recovery. This does not prove business backlog convergence.
- `docker-compose.authenticated.yml` adds Keycloak 26.4.0 with its own persistent
  PostgreSQL 16, and local TLS proxy (16 services total). The realm is derived from
  B's checked-in baseline, with exact HTTPS callback, separate generated Booking
  and Gateway secrets and isolated service-account roles. No human identity is
  invented and no signup/mapping automation is added.
- Keycloak uses native HTTPS and one issuer reachable with the same hostname/port
  from the browser and containers. Node validates the local CA through
  `NODE_EXTRA_CA_CERTS`. No disabled certificate validation.
- Monolith receives PR53 gates, credentials and persistent sidecar paths. Optional
  `AUTHENTICATED_AMQP_URL` starts C's monolith relay/payment/rating subscriptions;
  it defaults empty so legacy event history is not silently published.
- Private TLS port 18446 serves Booking and user Payments clients; port 18445 serves
  only the authenticated identity resolver. Neither is published to the host.
  Public service port 18444 blocks internal command routes. App origin preserves
  HTTPS Host/forwarded scheme for PKCE/same-origin callbacks.

## Preparation and infrastructure-only check

Use a **new checkout/project** and empty task-specific volumes. Never use an existing
application/Keycloak project or remove volumes to make configuration work.
Requires Docker Compose v2, Node 22+ and OpenSSL on PATH (or `OPENSSL_BIN`).

```sh
node scripts/prepare-authenticated-compose.mjs
docker compose --env-file .env.authenticated -p homeservice-e-auth-review \
  -f docker-compose.yml -f docker-compose.resources.yml \
  -f docker-compose.authenticated.yml -f docker-compose.authenticated-resources.yml \
  config --quiet
docker compose --env-file .env.authenticated -p homeservice-e-auth-review \
  -f docker-compose.yml -f docker-compose.resources.yml \
  -f docker-compose.authenticated.yml -f docker-compose.authenticated-resources.yml \
  up -d --build --wait --wait-timeout 240 \
  keycloak tls payments-wallet-consumer notifications-event-consumer payments-outbox-relay
node scripts/verify-authenticated-compose.mjs
```

After full startup, add `--full-stack` for application/monitoring HTTP checks.
`--faults` deliberately stops and restarts ONLY this disposable project's RabbitMQ
and verifies that all three worker readiness endpoints go 200 -> 503 -> 200.


Preparation refuses an existing `.env.authenticated` or `.local/authenticated`;
it does not rotate secrets or overwrite a realm. Both are ignored. Generated CA
and leaf certificates expire in 30 days. These local secrets/CA/private keys are
not production configuration and must not be attached to evidence or committed.
An interrupted preparation requires inspection; no destructive automatic retry.

The verifier reads secrets privately and sends them to the test container on stdin.
It checks 16 memory limits, disabled default cutover gates, actual Keycloak service
tokens/signatures/role isolation and trusted in-container TLS/routing. It does not
create financial commands or prove browser/user/AMQP business acceptance.
`--config-only` checks configuration without contacting running containers.
To change the disposable project, set `COMPOSE_PROJECT_NAME=homeservice-e-auth-NAME`.

## Browser and explicit application activation

Before browser use, arrange these local host names to resolve to 127.0.0.1 and trust
ONLY the generated local `tls/ca.pem` using the platform/browser trust procedure:

```text
127.0.0.1 app.homeservice.test id.homeservice.test payments.homeservice.test notifications.homeservice.test
```

Host mappings and OS trust are not modified by preparation. App origin is
`https://app.homeservice.test:18444`, issuer is
`https://id.homeservice.test:18443/realms/homeservice`. Ports are intentionally fixed
in this local overlay; changing them requires updating certificates/realm/URLs
together. The old base HTTP gateway is for legacy compatibility; use HTTPS for OIDC.

For a **reviewed empty disposable demo**, or separately approved real-data cutover:

1. Complete A/C source eligibility/checkpoint/event-watermark/migration review for
   any useful data. Do not publish old history or toggle ownership in place.
2. B/A provision real Keycloak human accounts, exact user audience roles and owned
   `(issuer,sub)->(role,domainId)` bindings. The existing monolith CLI remains the
   mapping interface. Browser/signup provisioning is a separate acceptance gate.
3. In the ignored environment file explicitly set `AREA_B_AUTH_ENABLED=true`,
   `OIDC_LOGIN_ENABLED=true`, `AUTHENTICATED_SERVICES_ENABLED=true`,
   `AUTHENTICATED_CUTOVER_APPROVED=true`, and set `AUTHENTICATED_AMQP_URL` to
   `amqp://homeservice:<the generated RABBITMQ_PASSWORD>@rabbitmq:5672?frameMax=131072`.
   No proxy-only flags should be enabled. This is an explicit owner decision.
4. Use the same four Compose files and project with `up -d --build --wait` to start
   the full stack, including monolith and observability. Do not run this against
   another project's volume. Receiver auth must be enabled with the same issuer.
5. Validate real login/refresh, API/RSC ownership, provider->wallet, financial
   completion/cancel/recovery, paid/notification/rating event delivery, duplicate
   counts, restarts/faults and Jaeger. Readiness alone does not close these gates.

Stop this project using the same Compose arguments and `down` WITHOUT `--volumes`.
Keep data and CA/secret material for intentional restart tests. No automatic
rotation, old-data reset, gateway cutover or shared deployment is performed here.

## Resource budget and outstanding work

Base 13-service limits total 5.875 GiB. With both authenticated overlays the 16-service
limits total 6.250 GiB; smaller initial limits for RabbitMQ/Prometheus/Grafana/Jaeger
reserve space for Keycloak, its DB and TLS. This is **configuration arithmetic**,
not 8 GB load-test evidence. Docker/OS/builds need separate headroom. Measure peak
usage, OOM, latency, errors, backlog and fault recovery before accepting these limits.

Remaining: real human browser/provisioning acceptance, monolith/wallet tracing
completion, whole-stack financial/event faults, clean-clone offline reproducibility,
legacy eligibility/data cutover and load testing. See the dated validation document
for exactly what was observed on this branch; fixture success is not live acceptance.

References: [Keycloak containers](https://www.keycloak.org/server/containers),
[health checks](https://www.keycloak.org/observability/health),
[A startup](authenticated-startup-handoff.md), [B auth](b-authentication-handoff.md).
