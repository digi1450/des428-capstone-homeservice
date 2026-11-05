# A service scaffold validation — 5 November 2026

Scope: first A implementation slice on `feat/a-extract-and-route`. This records scaffold checks, not completion of extraction, security, saga, D's three required faults, Pact or the final stack.

## Environment and observed checks

- Host Node v26.13.0; Docker Engine 29.9.2. Container tests used Node v22.23.4; PostgreSQL reported 16.15.
- `docker compose --env-file services/.env.example -f services/compose.dev.yml -p homeservice-a-check config --quiet`: passed.
- `docker compose --env-file services/.env.example -f services/compose.dev.yml -p homeservice-a-check up -d --build --wait`: passed; both apps and their two separate databases became healthy. A subsequent build of final source also passed.
- `npm --prefix contracts test`: 3 passed, 0 failed. Swagger Parser validates OpenAPI 3; Ajv validates draft fixtures and rejection examples. This is not Pact/provider verification.
- Tests in each service without TEST_DATABASE_URL: 3 passed and 1 database test skipped. With TEST_DATABASE_URL pointing to that service's disposable PostgreSQL: **4 passed, 0 failed, 0 skipped per service** on host Node.
- Repeated each service's 4 tests in its Node 22 image with a read-only mount of that service's `test/` directory and TEST_DATABASE_URL set from its own DATABASE_URL: **4 passed, 0 failed, 0 skipped per service**. These check migration replay, table separation, transaction commit/rollback, HTTP health behavior and config validation.
- All 135 original files matched the historical source SHA-256 manifest. The original 61-test monolith suite was not rerun because no monolith source/config/dependencies changed; the old run remains historical evidence.

To reproduce container tests while the isolated stack is running, from the repository root (replace SERVICE with notifications or payments-wallet and use an absolute repository path for the test mount):

```sh
docker compose --env-file services/.env.example -f services/compose.dev.yml -p homeservice-a-check run --rm --no-deps \
  -v /absolute/repository/services/SERVICE/test:/app/test:ro --entrypoint sh SERVICE \
  -c 'TEST_DATABASE_URL="$DATABASE_URL" node --test test/*.test.js'
```

The example env values were used only for this disposable local validation; use your own local passwords for development. No private credentials were required.

## Actual HTTP/database interruption smoke

Observed against the running containers:

| Check | Notifications | Payments & Wallet |
|---|---|---|
| GET /health/live with databases up | 200 alive | 200 alive |
| GET /health/ready with migrations applied | 200 ready | 200 ready |
| GET /internal/payment-intents (unimplemented route) | 404 NOT_FOUND | 404 NOT_FOUND |
| Notifications database stopped: liveness | 200 alive | Not rechecked in this step |
| Notifications database stopped: readiness | 503 not_ready | 200 ready |
| Notifications database restarted | Readiness recovered to 200 | No restart required |

The script stopped/started only `notifications-db` inside the `homeservice-a-check` project and restored it in a finally block. This demonstrates health/dependency isolation of the scaffold. It does not establish business recovery, message delivery, saga correctness or the final system's memory use. The temporary validation stack is stopped after validation; its database volumes are retained.

## Remaining work

B/C/D/E must review the draft contract and wire their authentication, command/outbox/dedupe, retry and deployment requirements. Business routers are not mounted; external business requests receive 404. The monolith still owns/serves all original flows pending cutover. New PostgreSQL schemas are initial business schemas; migration/backfill, compatible serialization, command fences and actual business writes remain subsequent A/C work. No final root Compose, nginx, broker, Keycloak, observability or end-to-end proof is claimed here.
