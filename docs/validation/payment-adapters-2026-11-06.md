# Payments adapter validation — 6 November 2026

Scope: prepared monolith Payments HTTP client and Booking mapping adapter. No existing caller or runtime configuration was switched. Internal command paths remain service-side drafts awaiting C/B integration.

## Original slice checks (before the pre-merge fix)

| Check | Result |
|---|---|
| New Payments client/Booking adapter tests on host Node 26 | 18 passed, 0 failed |
| Full monolith suite in Node 20 Docker image, including the same 18 tests | 85 passed, 0 failed, 0 skipped (67 preceding + 18 new) |
| New real Payments client → HTTP read API → PostgreSQL boundary test | 1 passed, 0 failed, explicit auth test double |
| Isolated Payments image build / app + database healthy boot | Passed |

Distinct test count for this slice is 86; the host repeat of 18 client tests is not counted twice. Tests cover unchanged public wallet/history shapes and token/trace forwarding; explicit same-key/body retries; encoded lookups; distinct cancel keys; unknown query 404, command HTTP errors, timeout, lost reply, mismatched identity/booking/amount, voided results and malformed/type-drift payloads; no redirects/leaked credentials; COD no-op and immutable trusted-order mapping. A simulated lost-reply server observes no automatic retry and then an explicit retry with the identical key/body.

The real boundary test seeds an isolated COD commission through the Payments business primitive, then checks wallet/history owner isolation using the actual new client and HTTP router with PostgreSQL. It also calls currently unmounted command routes: the client reports UNKNOWN, and no intent is created. This is not real mutation command/fence integration. Token verification in the test is a clearly identified synthetic mapping, not Keycloak.

All 135 inherited source hashes remain unchanged. Existing monolith routes/pages and SQL modules remain active; the new modules are not imported by them. No dependencies, service schemas or existing Payments service code changed in this slice. The previous 22 Payments tests and 9 contract checks are recorded in their earlier report, not claimed rerun here.

## Reproduction

```sh
docker compose -f bangkok-homeservice/docker-compose.yml run --rm --build test
# After installing the existing service/monolith dependencies and starting an isolated Payments DB:
TEST_DATABASE_URL='postgresql://USER:PASSWORD@127.0.0.1:PORT/DB' node --test tests/integration/payments-boundary.test.mjs
```

The boundary test is skipped without TEST_DATABASE_URL. For this recorded run it was explicitly enabled against a disposable database in the homeservice-payments-client-check project and passed. Tests delete only their generated wallet/ledger row. The temporary app/database project is stopped afterward with volumes retained; no unrelated project was stopped or reset.

## Remaining evidence

C's durable command responses/cancellation fences and recovery, real B token/subject mapping, live public Booking and Server Component cutover, D retry/fault runs, Pact, nginx/full Compose, traces and memory-budget validation remain to implement/run. Fixture-server command tests do not substitute for those requirements.

## Pre-merge review fix — dot-segment identifiers

Review found that `.` and `..` passed command-key validation but URL normalization prevented looking them up at their intended path. The Payments client, Booking adapter and all command/saga key positions in the draft OpenAPI now reject exactly those values. Request/correlation ID validation is unchanged; normal dotted keys still resolve to their literal command path.

Post-fix checks: **20/20** targeted client/adapter tests on host Node 26, **87/87** full monolith tests in Node 20 Docker, and **10/10** contract checks passed with no skips. Distinct latest executed checks total 97 (targeted tests are included in the monolith suite). Regression cases reject dot IDs before any HTTP and verify normal dotted IDs against a real local HTTP server. The earlier PostgreSQL read-boundary result above was not rerun: read transport/service/database code is unchanged. No actual C mutation endpoint is claimed tested.
