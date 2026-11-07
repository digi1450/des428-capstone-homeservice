# Area E observability integration — 7 November 2026

Status: E's logging, HTTP metrics, Grafana provisioning, per-service tracing and service-test CI have been integrated with main through C PRs #14–18 on this branch. This remains a partial final stack, not completed Area E or live business cutover. See [validation](validation/e-main-sync-2026-11-07.md), [C messaging handoff](c-messaging-handoff.md), [shared status](project-status.md), [gateway](nginx-handoff.md) and [data/caller runbook](data-cutover-handoff.md).

## Available

- Both HTTP apps emit JSON request logs with service/requestId/traceId/method/path/status/duration; no request body, query string or authorization header is logged by this middleware.
- `/metrics` exposes request counters and latency histograms. Prometheus scrapes `notifications:3001` and `payments-wallet:3002`. Grafana provisions the Request Rate, 5xx Error Rate and P95 dashboard.
- Root Compose and `npm start` preload OpenTelemetry before each HTTP server. HTTP and PostgreSQL spans reach Jaeger with the configured service name. Both default service names were corrected; Payments now declares its directly imported OTel API dependency explicitly.
- CI uses Node 22 and an isolated PostgreSQL per matrix job. `TEST_DATABASE_URL` enables database tests including C's new inbox/outbox suites. E's OTel/metrics dependencies and C's `amqplib` are both retained in regenerated locks.
- Root Compose keeps A's baseline routing. It includes the monolith, gateway, both service databases/apps and observability tools. It does not yet include B's Keycloak or C's RabbitMQ/relay/consumer processes. No saga/Payments mutation endpoints are activated here.

## Local setup

From repo root, copy `.env.example` to `.env`, replace all password placeholders, then run `docker compose up -d --build --wait`. This is an initial root stack, not the final full-course command/clean-clone evidence. It starts the inherited monolith bootstrap, which still DROP/reseeds even with the new volume: use only disposable demo data until non-destructive startup and cutover are implemented. Never restart/reset a useful original project just to free a port.

Default host ports: gateway 18080 (`GATEWAY_PORT` configurable; internal nginx still listens on 8080), Grafana 3003 (`GRAFANA_PORT` configurable), Prometheus 9090 (`PROMETHEUS_PORT`), Jaeger 16686 (`JAEGER_UI_PORT`). Select free host ports before startup if other projects use them. Original monolith port 3000 is not published by this root file. In the integration rehearsal, gateway was not started and test Grafana used 3303; unrelated applications were left running.

The root Grafana admin password comes from `GRAFANA_ADMIN_PASSWORD` (username admin); it is not embedded in Compose. Initial database/Grafana passwords initialize new volumes only: changing env values does not rotate existing users' passwords. Do not delete useful volumes to force rotation. Service-only development Compose still works separately, but its current commands do not preload tracing; use the root stack or an explicit `node --import ./src/tracing.js src/server.js` for these tracing checks.

## Still to integrate with E and the team

1. RabbitMQ quorum topology, Payments relay and Notifications consumer processes, monolith AMQP settings and broker credentials; follow C's handoff. HTTP tracing does not automatically prove trace continuation through those separate processes/AMQP.
2. B real token validation/credentials, A/C payment endpoints/fence/eligibility and caller changes; test a real multi-service business trace afterward. Current business HTTP remains fail-closed until B wiring.
3. Pact consumer/provider contracts and one-command verification, GitHub Actions/act coverage, actual fault/concurrency tests, complete root boot/readiness, durable/non-destructive monolith startup and the combined 8 GB measurement.
4. Dossier/demo scripts, concrete observations and owner review. Update OWNERS/status when more work merges; fixture results are not a final-grade claim.
