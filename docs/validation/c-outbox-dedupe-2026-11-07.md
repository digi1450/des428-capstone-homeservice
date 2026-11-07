# C outbox / RabbitMQ / dedupe — recorded validation, 7 November 2026

Branch `feat/c-outbox-dedupe`. These are the commands and results actually observed. Fixture-level and local-run evidence only: not the final root Compose stack, not Keycloak, not the Booking saga.

## Environment

- Node v22.23.4. PostgreSQL 16.15 (Ubuntu package, local cluster) and RabbitMQ 3.12.1 (Ubuntu package, default `guest` user on localhost) in a disposable cloud workspace. Docker Hub was not reachable from that workspace, so the repository's Compose files were **not** used for this run.
- Disposable databases: `c_payments`, `c_notifications` (and `mig_n`, `mig_p` for the importer tests), all created empty for this run.

## Commands and results

| Check | Command (from repository root unless noted) | Result |
|---|---|---|
| Payments unit + PostgreSQL suite (includes new `outbox.test.js`) | `TEST_DATABASE_URL=…/c_payments npm test` in `services/payments-wallet` | 31 pass, 0 fail |
| Notifications unit + PostgreSQL suite (includes new `inbox.test.js`) | `TEST_DATABASE_URL=…/c_notifications npm test` in `services/notifications` | 37 pass, 0 fail |
| Contracts (includes new `event-envelope.test.js`) | `npm --prefix contracts test` | 15 pass, 0 fail |
| End-to-end Payments → RabbitMQ → Notifications | `TEST_PAYMENTS_DATABASE_URL=… TEST_NOTIFICATIONS_DATABASE_URL=… TEST_AMQP_URL=… node --test tests/integration/c-outbox-to-notifications.test.mjs` | 5 subtests pass (below) |
| Existing A boundary tests | `TEST_DATABASE_URL=… node --test tests/integration/payments-boundary.test.mjs` and `notifications-boundary.test.mjs` | 1 pass each (after `npm ci --ignore-scripts` in `bangkok-homeservice` for the monolith client's dependencies) |
| A data-migration importer with the new migrations | `SNAPSHOT_FIXTURE_DIR=… NOTIFICATIONS_TEST_URL=… PAYMENTS_TEST_URL=… node --test import.test.mjs` in `tools/data-migration`, plus `python3 -m unittest … test_export.py` | Before the pin update: `SCHEMA_REVIEW_REQUIRED` failures as designed. After: 21 pass, 0 fail; exporter OK |

End-to-end subtests observed passing:

1. A committed `payment.succeeded` waits in `outbox_events` while no relay runs (0 notifications after 300 ms); one relay pass delivers it: 1 notification, 1 `processed_events` row with `effect_count = 1`.
2. Republishing the same event twice (row reset to unpublished to simulate a relay crash after publish, plus one direct republish): consumer logged 2 duplicate skips; notifications stayed at 1; `processed_events` still 1 row.
3. Consumer stopped: the next event was confirmed by the broker and held in `notifications.events` (`messageCount = 1`); after the consumer restarted the notification count reached 2.
4. An envelope with `schema_version = 2` and a `payment.succeeded` claiming `producer = monolith` both reached `notifications.events.dlq` (2 messages); main queue 0; no extra notifications.
5. An event with no bound queue (`test.unbound_event`) stayed unpublished with `last_error` starting `unroutable`.

Also covered by the service suites: outbox row rolls back with a failed business transaction; `settleWebhook` stages exactly one event and a staging failure rolls back the charge; failed publish backs off and is retried; two relays never claim the same leased row; after an expired lease the same `event_id` is republished; 5 concurrent deliveries of one event produce 1 notification; dedupe is per consumer; invalid data leaves no dedupe row; a failure after the dedupe insert rolls both back and the retry succeeds.

## Real process kill run

`PAYMENTS_DATABASE_URL=… NOTIFICATIONS_DATABASE_URL=… AMQP_URL=… tests/integration/c-relay-kill-demo.sh` starts the real `event-consumer.js` and `outbox-relay.js` processes, commits payments through `settleWebhook`, and sends `kill -9` to the relay:

```text
step 1 relay running   : committed=3 pending=0 notifications=3
step 2 relay KILLED -9 : committed=8 pending=5 notifications=3
step 3 relay restarted : committed=8 pending=0 notifications=8
consumer duplicate skips: 0
```

Committed events survived the killed relay in the outbox and were delivered once after restart.

## Not run / limits

- Monolith inherited test suite: not run (no monolith files changed).
- `tests/gateway` and the importer's own Compose runner: not run (container images unavailable in this workspace); the importer test file itself was run against local PostgreSQL as above.
- Settlement eligibility is a test stub returning true. No Keycloak, nginx, OTel trace continuation, or 8 GB stack measurement.
- Timings above are poll intervals chosen for the test, not performance measurements.
