# Prepared nginx routing — A → B/C/D/E

Status: routing preparation, not active migration. The original application and `services/compose.dev.yml` are unchanged. The fixture stack is not the final course stack. See [recorded validation](validation/nginx-routing-2026-11-06.md).

## Files and activation

- `infra/nginx/nginx.conf`: shared HTTP gateway on container port 8080.
- `infra/nginx/routes.baseline.conf`: DEFAULT when E wires the gateway; existing public traffic goes to the monolith.
- `infra/nginx/routes.services.conf`: candidate cutover routes, tested but NOT a default/live deployment.
- `tests/gateway/`: disposable echo backends and real-nginx routing/outage tests. They do not implement or verify application authentication/business logic.

E owns the final root Compose. Merge the following service fragment into that future root file, on a Docker network shared with the three application services. This is a fragment, not a runnable full-stack command:

```yaml
services:
  gateway:
    image: nginx:1.28-alpine
    ports:
      - "127.0.0.1:8080:8080"
    volumes:
      - ./infra/nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./infra/nginx/routes.baseline.conf:/etc/nginx/routes.conf:ro
```

The exact Docker service names/ports are `edemand:3000`, `notifications:3001`, `payments-wallet:3002`, matching the current app/dev Compose names. If E changes names, update the upstreams and tests together. Do not connect to host localhost from inside nginx. No public host binding is needed for the service databases; B/E decide final service-port exposure. Do not use this HTTP-only local fragment as a public TLS deployment.

The config uses Docker DNS at `127.0.0.11`, shared upstream zones and `resolve`; it requires open-source nginx >=1.27.3. Tested image is `nginx:1.28-alpine`. Resolver validity is 5 seconds and DNS timeout 2 seconds. Missing backends can return 502 while nginx remains alive; endpoint recovery is eventually resolved. This is not application readiness or a promise of zero interruption. References: [upstream resolution](https://nginx.org/en/docs/http/ngx_http_upstream_module.html#resolve), [proxy URI behavior](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass), [retry control](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_next_upstream).

## Public route ownership

| Path | Baseline | Candidate |
|---|---|---|
| `/api/notifications`, `/api/notifications/...` | Monolith | Notifications |
| `/api/provider/wallet`, `/api/customer/transactions` and their slash subpaths | Monolith | Payments & Wallet |
| `/api/payments`, `/api/payments/...` | Monolith | Payments & Wallet; mutations still unmounted pending B/C |
| `/internal`, `/internal/...` | Gateway 404 | Gateway 404 |
| `/gateway/health` | Gateway liveness JSON | Gateway liveness JSON |
| Everything else, including HTML inbox/wallet/dashboard, Next assets, `/api/health`, Booking/Bidding and similarly named prefixes | Monolith | Monolith |

No public internal-command route is added. C calls the owning service directly over the private network with B's service credentials. `/health/live` and `/health/ready` on each service are checked directly by E, not exposed as public service-health aliases. `/api/health` remains the inherited monolith route.

Gateway routing cannot migrate direct SQLite calls in Next Server Components or the monolith relay. Readers, writers, producers and data backfill must switch coherently; see [caller inventory](extraction-inventory.md). Route errors/unknown IDs stay with the owning service; there is no fallback to monolith data after service failure.

## Request/response contract and integration decisions

The gateway forwards method, body, original path/query, Authorization, Cookie, traceparent and tracestate; no prefix rewrite, response projection, cache, auth bypass, retry or SQLite fallback is implemented. Gateway does not generate C/D idempotency keys. Upstream status, body, Set-Cookie, Retry-After and Location pass through, including errors and redirects. Oversized bodies may receive gateway 413 (1 MiB limit); upstream/framework limits still apply.

One `X-Request-Id` is forwarded and returned: retain a client ID matching `[A-Za-z0-9._:-]{1,128}`, otherwise generate nginx's request ID. The upstream response copy is hidden to avoid duplicates. IDs support correlation, never dedupe or authority. Real OTel propagation/export and spans remain E's work; passing trace headers does not prove a distributed trace.

`Host` and `X-Forwarded-Host` preserve the incoming host/port. This config assumes nginx is the direct local entrypoint: it overwrites X-Forwarded-For/X-Real-IP with the connection address and X-Forwarded-Proto with its own scheme; it strips caller Forwarded, X-Role and X-User-Id. If E puts a TLS proxy before nginx, B/E must define trusted proxy networks and scheme handling before changing this policy. Services still independently validate B's tokens and recipient ownership; forwarded cookies/headers are not proof of identity. Preserve other credential headers needed by inherited flows until B replaces them in a coordinated change.

`proxy_next_upstream off` prevents gateway replay, especially financial POSTs. D/C own bounded retries with stable command keys and unknown-outcome recovery. Connect timeout is 2 seconds; send/read timeouts are 30 seconds between I/O operations, not a total request deadline. These are initial integration settings for D/E to validate. Response buffering is off for Next streaming. No WebSocket upgrade handling is included; the supplied production source has no WebSocket flow.

Access logs contain method, normalized path, status and request ID, omitting queries, credentials and bodies. nginx error logs can include request details such as a query string: E/B must handle log privacy/retention. This slice uses no real tokens or customer data. One worker/256 connections are starting settings, not proof of throughput or the full-stack 8 GB requirement.

## Cutover acceptance — coordinate before choosing candidate

1. B supplies real end-user/service auth, role/domain-ID mapping, token forwarding and real ownership/expired/wrong-audience tests. Current service bootstraps intentionally fail closed with 503 for business routes.
2. C supplies durable command result/fence, saga/outbox/dedupe/recovery, event producers and eligibility/settlement integration. Mount authorized Payments mutation endpoints before routing simulation/webhook traffic there. See [Payments handoff](payments-business-handoff.md) and [mapping handoff](notification-mappings-handoff.md).
3. A completes existing-data migration/ID sequences and ALL API, Server Component, signup, Booking and notification writer changes. Stop old table reads/writes/relay together, retaining ratings with their monolith owner. No split SQLite/PostgreSQL truth.
4. D verifies actual financial/inbox faults and retries through the integrated gateway. E wires the final offline root stack, both Pact seams, telemetry and resource checks. Test HTML/UI flows as well as HTTP routes, gateway/COD booking, payment callbacks, wallet/history and notification ownership.
5. Once reviewed together, E mounts `routes.services.conf` as `/etc/nginx/routes.conf`, validates with `nginx -t`, and recreates/reloads the gateway using the final team's service name. Record the selected mode and evidence. Keep baseline until that coordinated switch is ready; no environment switch is enabled by this PR.

Baseline is safe for the current untouched monolith. After live data/writers move, switching just nginx back to baseline is NOT a safe rollback: stop writes and use a reviewed data/caller rollback plan or roll forward. Do not route to stale SQLite as an automatic recovery mechanism.

## Reproduce routing tests

From the repo root with Docker running:

```sh
sh tests/gateway/run.sh
```

The runner uses the isolated project `homeservice-gateway-test`, no host ports or persistent volumes. It downloads nginx/Node images when missing, starts both modes with three echo backends, validates syntax, runs routing tests, stops Notifications, recreates the candidate gateway while Notifications is down, then recreates Notifications and checks recovery without another gateway reload. It removes only its own fixture containers/network on exit. Do not use that project name for real application data or run two copies simultaneously. These tests do not start/reseed the original app or stop other project stacks.
