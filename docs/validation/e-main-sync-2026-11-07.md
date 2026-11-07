# E branch + current main integration — 7 November 2026

Inputs: main `5e9b0d2` (C PRs #14–18) and E `e91c6d7`. Work took place in an isolated worktree. Existing user workspace remained on its original main checkout; no production data or unrelated project was reset.

## Changes during integration

- Resolved both services' package.json/package-lock conflicts by retaining C's amqplib and E's telemetry/metrics packages. Locks were regenerated from E's resolutions, then clean installs succeeded.
- Corrected swapped tracing default names; enabled tracing consistently in Notifications npm start; declared Payments' directly imported @opentelemetry/api dependency.
- Added an environment example and env-supplied Grafana initialization password, configurable gateway/Grafana host ports and Grafana default 3003 to avoid the original monolith's 3000.
- Added one observability regression test per service: metrics/log fields and correlation, no query/token in JSON request logs, and no business-auth bypass.

## Executed checks

All commands were run against this integrated tree, with disposable test credentials only.

- `npm ci` for both services succeeded after lock resolution; installed contracts separately.
- `docker compose -p homeservice-e-sync --env-file <private-fixture-env> config --quiet` passed.
- Built the two service images from merged sources. Started only both PostgreSQLs/apps, Jaeger, Prometheus and Grafana in the isolated `homeservice-e-sync` project (no monolith or gateway). Both apps passed database readiness with C migrations applied.
- Ran each image with its current `test/` mounted read-only and `TEST_DATABASE_URL` set to its own fixture database: **Notifications 38 passed, Payments 32 passed, 0 failures/skips**. Includes existing A/C tests plus one new observability test per service. Runtime Node 22.
- Ran `docker compose -p homeservice-e-sync-monolith -f bangkok-homeservice/docker-compose.yml run --rm --build test`: **114 passed, 0 failures/skips**, isolated in-memory SQLite under Node 20, no live monolith start.
- Ran contract/schema suite on host Node 26: **16 passed, 0 failures/skips**. These are existing schema tests, not Pact.
- Prometheus target API reported both service jobs **up**. Grafana health database reported **ok**; authenticated API returned the provisioned Bangkok Homeservice dashboard after initializing a fresh disposable test Grafana volume with the fixture env password.
- Sent separate `/health/ready` requests with explicit fixture traceparent/request IDs. JSON logs retained the supplied trace IDs (`111…` Notifications and `333…` Payments). Jaeger API returned each matching trace, with GET, `pg-pool.connect` and PostgreSQL query spans for that service. This confirms log↔trace linkage and HTTP/PG spans within EACH service, not a multi-service business trace.
- Whitespace and lock/manifest dependency consistency checked. CI for the final pushed head is reported in its PR checks, not assumed from an older E run.

## Limits

No RabbitMQ processes, Keycloak, real business cutover, A/C missing internal payment endpoints or AMQP span continuation were exercised by this rehearsal. No Pact/act, full root monolith/gateway boot, browser dashboard QA, clean-clone or total memory/latency benchmark is claimed. The full final stack and persistent/non-destructive monolith startup remain team integration work.

Only the isolated test projects/volumes were removed after checks; unrelated AW5/Dify containers stayed running. The worktree and PR retain code/evidence, not test credentials or exported private data.
