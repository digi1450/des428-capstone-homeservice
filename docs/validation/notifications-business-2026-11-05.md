# Notifications business slice validation — 5 November 2026

Scope: A's PostgreSQL business/read API, internal transaction write hook, prepared monolith HTTP adapter and Notifications contracts. Auth tests inject synthetic identity mappings; no real Keycloak/RabbitMQ/gateway or active monolith cutover is claimed.

## Observed results

| Check | Result |
|---|---|
| Notifications tests with isolated PostgreSQL, host Node 26 | 14 passed, 0 failed, 0 skipped |
| Same Notifications tests in built image, Node v22.23.4 | 14 passed, 0 failed, 0 skipped |
| Full monolith Docker suite (Node 20 image), including new client tests | 67 passed, 0 failed, 0 skipped (61 inherited + 6 new) |
| OpenAPI/fixtures suite, host Node 26 | 6 passed, 0 failed (3 Notifications + 3 Payments draft) |
| Monolith adapter → actual HTTP router → PostgreSQL boundary test | 1 passed, 0 failed, with explicit auth test double |
| Notifications image build and isolated Compose healthy boot | Passed |
| Default deployed verifier absent, including forged bearer/role/ID headers | GET inbox and POST mark-read returned 503; health/ready returned 200 |

The distinct test total is 88 across Notifications (14), monolith (67), contracts (6) and boundary (1); running Notifications on two runtimes is not counted twice. A first restricted host client-test attempt could not open localhost ports (EPERM); rerunning with local network permission passed all 6 tests. This environment failure is not represented as a product test failure or hidden as a skip.

Business assertions include role+ID-scoped newest-first inboxes, numeric IDs and ISO/null dates, 401/403/404/400 behavior, unchanged read timestamp under four concurrent mark-read requests, and rollback of a notification inserted through C's supplied transaction client. Tests check unexpected DB error scrubbing and fail-closed behavior without B's verifier. These preserve existing ownership behavior; they are not evidence of fixing an inherited BOLA flaw or D's required race.

Client checks include bearer/request/trace forwarding without raw identity headers, correct read/list paths, expected 4xx statuses, safe unavailable errors, refusal of malformed/private response fields, no redirect forwarding of credentials, and a deadline covering a response body stalled after headers. The boundary test verifies the actual adapter against the service router and PostgreSQL, including mark-read and a different-role rejection. It does not invoke the original application's routes or Server Component.

## Commands and reproduction

Use [service setup](../../services/README.md) and [Notifications handoff](../notifications-handoff.md). Validation used the `homeservice-notifications-check` Compose project, creating only Notifications and its own database with disposable example credentials. For PostgreSQL tests, set TEST_DATABASE_URL to that isolated database, never a live database.

```sh
npm --prefix contracts test
docker compose -f bangkok-homeservice/docker-compose.yml run --rm --build test
TEST_DATABASE_URL='postgresql://USER:PASSWORD@127.0.0.1:PORT/DB' npm --prefix services/notifications test
TEST_DATABASE_URL='postgresql://USER:PASSWORD@127.0.0.1:PORT/DB' node --test tests/integration/notifications-boundary.test.mjs
```

For Node 22 service tests, run the Notifications image on the isolated Compose network with its `test/` directory mounted read-only at `/app/test` and `TEST_DATABASE_URL` set from its own DATABASE_URL, as in the first scaffold's validation recipe. The temporary validation stack is stopped afterward with volumes retained. No unrelated project was stopped or reset.

## Limits

The original monolith handlers, page, notification relay, provider-approval writer and SQLite data ownership remain active pending coordinated cutover. Real token verification, durable event envelope/producer validation and dedupe, rating ownership split, migration/backfill and sequence handling, nginx/Pact/telemetry, and final memory/fault evidence remain to implement. `record()` alone is not idempotent event delivery; C must put consumer dedupe and writes into the same local transaction.
