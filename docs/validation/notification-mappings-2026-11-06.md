# Notification mapping validation — 6 November 2026

Scope: A's pure business mappings and atomic batch writer. No inherited source, live monolith flow, broker consumer or auth bootstrap was changed.

## Observed final checks

| Check | Result |
|---|---|
| Notifications suite with isolated real PostgreSQL on host Node 26 | 29 passed, 0 failed, 0 skipped |
| Same suite in Notifications Node 22 Docker image | 29 passed, 0 failed, 0 skipped |
| Projection schema/fixtures plus existing contract suite | 13 passed, 0 failed, 0 skipped |
| Exact parity against actual inherited relay/direct approval writer, Node 20 Docker + in-memory SQLite | 9 passed, 0 failed, 0 skipped (parent plus 8 cases) |
| Isolated Notifications image build / app + database healthy boot | Passed |

Distinct total is 51 checks (29 + 13 + 9); the repeated Node 22 run is not counted twice. An earlier run without database opt-in passed the non-DB checks and explicitly skipped DB suites; final PostgreSQL runs above have no skips. All 135 original monolith source hashes remain unchanged. The full monolith suite was not rerun because its code/config/dependencies did not change; instead the targeted parity harness exercises the original notification paths directly.

Pure checks cover all six public booking statuses/counterparty rules, exact review/completion/bid/payment/approval messages, loser null order IDs, no-target payments, input immutability and rejecting unknown/invalid values before SQL. No source private extras are copied into notification commands.

Actual PostgreSQL checks cover: a winner plus two losers stored atomically; a deliberately injected second-insert failure rolling back the first real insert; rollback of caller-owned SQL dedupe probe and all effects; four concurrent attempts using an explicit caller-owned SQL dedupe pattern producing one batch; and repeated standalone calls producing repeats (the writer does not claim transport dedupe). Fixture row IDs and the temporary probe table are cleaned up by the tests. These are local atomicity/pattern checks, not RabbitMQ delivery or D's full fault/race rubric.

Parity cases compare the new mapper with results of runRelayOnce() from the unmodified original source for review.created, provider/customer booking transitions, booking.completed, bid.accepted, payment.succeeded with provider and explicit null provider, plus approveProvider() for the direct approval message. The review case runs the old rating recomputation too; the new mapper only projects notification text and does not claim to migrate rating ownership.

## Reproduction

From the repository root, use the isolated Notifications scaffold setup for DB tests, then:

```sh
TEST_DATABASE_URL='postgresql://USER:PASSWORD@127.0.0.1:PORT/DB' npm --prefix services/notifications test
npm --prefix contracts test
```

The parity harness is opt-in. Use the monolith test image for its native SQLite addon and mount the pure Notifications package/source read-only; no host native addon is required:

```sh
docker compose -f bangkok-homeservice/docker-compose.yml run --rm --build \
  -v "$PWD/services/notifications/package.json:/notifications-module/package.json:ro" \
  -v "$PWD/services/notifications/src:/notifications-module/src:ro" \
  -v "$PWD/tests/integration/notification-mapping-parity.test.mjs:/app/test/notification-mapping-parity.test.mjs:ro" \
  -e NOTIFICATION_MAPPER_MODULE=file:///notifications-module/src/event-mappings.js \
  --entrypoint node test --test test/notification-mapping-parity.test.mjs
```

Without the opt-in variable the harness is skipped. In this recorded run it was enabled and all cases passed. The harness imports the monolith test bootstrap first, so every freshBoot() operates only on in-memory SQLite. No persistent application database is mounted/reset.

The PostgreSQL validation project is homeservice-notification-mappings-check; it is stopped afterward, retaining its volumes. No unrelated project is stopped. Real C envelope validation/dedupe/broker lifecycle/provider-approval producer, ratings-consumer cutover, B tokens, E integration and final application data migration remain pending.
