# C monolith outbox → RabbitMQ — recorded validation, 7 November 2026

Branch `feat/c-monolith-outbox` (stacked on `feat/c-outbox-dedupe`). Commands and results actually observed. Same environment as the [first C record](c-outbox-dedupe-2026-11-07.md): Node v22.23.4, local PostgreSQL 16.15, RabbitMQ 3.12.1, disposable databases, no Docker images.

| Check | Command | Result |
|---|---|---|
| Monolith inherited suite + new `test/broker-relay.test.js` | `node --test` in `bangkok-homeservice` (in-memory SQLite) | 96 pass, 0 fail (87 before this change, all still passing) |
| End-to-end monolith → RabbitMQ → Notifications | `TEST_NOTIFICATIONS_DATABASE_URL=… TEST_AMQP_URL=… node --test tests/integration/c-monolith-to-notifications.test.mjs` | 3 subtests pass |
| Contracts (monolith envelopes validated against the shared schema) | `npm --prefix contracts test` | 16 pass |
| Regression: Payments, Notifications, Payments → Notifications end-to-end, A boundary tests | as in the first record | 31 / 37 / 6 / 1 + 1 pass |
| Production build | `npx next build` in `bangkok-homeservice` | Succeeded; `amqplib` and `better-sqlite3` traced into `.next/standalone/node_modules` |
| Boot smoke with a broker | standalone `server.js` with a temporary `DB_PATH` and `AMQP_URL` | `/api/health` 200; log shows `outbox relay started` and `broker relay started`; no error-level log lines |

Monolith relay cases observed in `test/broker-relay.test.js`: a booking writes its event with a UUID in the same transaction and a rejected (409) booking writes none; the v1 envelope is published once and marked; publishing and the inherited local dispatch do not consume each other's state; legacy `payment.succeeded` rows are never published; approval writes `provider.approved`; a failed publish backs off and is retried; a live lease blocks other relays and after expiry the same `event_uuid` is republished; credential-like payload keys are refused.

End-to-end cases observed: a customer's booking produced exactly one `booking_status` notification for the provider in the Notifications database; two further republishes of the same event were logged as duplicate skips with the count still 1; approving the seeded pending provider produced one `provider_approved` notification.

Not run: the Compose-based paths and `tests/gateway` (images unavailable); a SQLite file shared by two relay processes (the in-process relay was tested; multi-process leasing relies on SQLite's IMMEDIATE transaction locking and was not exercised).
