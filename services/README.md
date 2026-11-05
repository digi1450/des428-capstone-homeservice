# A's first service scaffold

Recorded checks: [first scaffold validation](../docs/validation/a-scaffold-2026-11-05.md).

Implemented here: two independently installable Express apps, PostgreSQL pools and same-client transaction hooks, additive/checksummed migrations, liveness/readiness and container builds. Business routes, auth, brokers, saga and gateway routing are pending. The original monolith still serves every user flow from SQLite; these new databases are not yet authoritative for production traffic.

## Start the isolated development stack

From the repository root, with Docker running:

```sh
cp services/.env.example services/.env
# Edit the two local passwords in services/.env (use URL-safe characters here).
docker compose --env-file services/.env -f services/compose.dev.yml up -d --build --wait
curl -f http://localhost:3001/health/ready
curl -f http://localhost:3002/health/ready
```

Notifications uses port 3001 and its own PostgreSQL on localhost:5433; Payments & Wallet uses 3002 and PostgreSQL on localhost:5434. Override the four ports in services/.env if occupied. Databases use separate volumes, users and passwords. Ports bind to localhost only. The dev bootstrap users own their databases; E/B must define least-privilege runtime/migration roles in the final stack. This scaffold is not the final root full-stack Compose or evidence of the 8 GB budget.

The dev command applies migrations before starting each app. Migrations never drop/reseed existing business data. Once applied, don't edit a migration; add the next numbered file. Changing the password in the env file does not rotate an existing volume's database password. Do not delete a useful volume to work around this.

```sh
docker compose --env-file services/.env -f services/compose.dev.yml logs --tail=50 notifications payments-wallet
docker compose --env-file services/.env -f services/compose.dev.yml down
```

`down` retains data. Never use `down -v` on data you need.

## Local development and tests

Node >=22; each service has its own package-lock. From either service directory:

```sh
npm ci
npm test
cp .env.example .env
# Set DATABASE_URL to that service's own database; don't use the other's credentials.
node --env-file=.env src/migrate.js
node --env-file=.env src/server.js
```

Health tests inject the database check. PostgreSQL integration tests are skipped unless `TEST_DATABASE_URL` is explicitly set to a disposable database. They run migrations and use a temporary probe table, checking migration replay, commit/rollback and table separation. They do not prove outbox/saga/business correctness. To opt in from the service directory:

```sh
TEST_DATABASE_URL='postgresql://SERVICE_USER:LOCAL_PASSWORD@127.0.0.1:PORT/DISPOSABLE_DATABASE' npm test
```

The image uses Node 22. Local Node versions may differ: record the runtime used when reporting test results.

## Files to work in

| Owner | Starting files / integration point |
|---|---|
| A | Each `src/app.js`, business modules/repositories to add, `migrations/`, [caller inventory](../docs/extraction-inventory.md), [payment contract](../contracts/payment-intents.openapi.json) |
| B | Add token-verification middleware before business routers in `src/app.js`; coordinate issuer/audience/roles/domain-ID mapping with A/C. Health routes expose no domain data |
| C | Add outbox/inbox/command/fence migrations; pass the `client` from `database.withTransaction(async client => ...)` to every SQL statement for an atomic effect. Add messaging modules and Booking saga/recovery in the monolith |
| D | Add timeout/retry/idempotency modules/tests against proposed contracts; injected health failures here are not the three real fault experiments |
| E | Use service names, ports and health endpoints above when writing root Compose. Add broker/Keycloak/telemetry/Pact/CI and real trace context propagation |

Never start a second pool/transaction inside `withTransaction` to write the associated outbox. Do not call remote services from an open database transaction. The two small bootstrap implementations are intentionally independent so neither service imports another service's runtime or database configuration.

## Health and pending business routes

`GET /health/live` checks only that HTTP is alive; `GET /health/ready` checks the service's database migration version and returns 503 on failure. Responses disable caching and carry X-Request-Id. A healthy scaffold does not mean extraction is finished. No business API is mounted yet; requests to those routes receive 404. There is no unauthenticated fake success/write endpoint.

From the repository root, validate the draft document and fixtures with `npm --prefix contracts ci` then `npm --prefix contracts test`. These are schema checks, not Pact or provider integration tests.

The [draft OpenAPI](../contracts/payment-intents.openapi.json) and [examples](../contracts/fixtures/payment-intents.json) are proposed A/C/D integration artifacts, not runtime responses. B/C/D/E must review them before treating them as agreed contracts. The full payment flow still requires command persistence/fencing, outbox and auth before public callers move. Events remain C-owned; see [migration handoff](../docs/migration-handoff.md#6-events-keys-and-tracing--proposed-v1).
