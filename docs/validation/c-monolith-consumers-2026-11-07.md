# C monolith consumers — recorded validation, 7 November 2026

Branch `feat/c-monolith-consumers` (stacked on `feat/c-monolith-outbox`). Commands and results actually observed. Same environment as the earlier C records: Node v22.23.4, local PostgreSQL 16.15, RabbitMQ 3.12.1, disposable databases, no Docker images.

| Check | Command | Result |
|---|---|---|
| Monolith suite incl. new `test/event-consumers.test.js` | `node --test` in `bangkok-homeservice` | 103 pass, 0 fail |
| Payments → RabbitMQ → monolith Booking | `TEST_PAYMENTS_DATABASE_URL=… TEST_AMQP_URL=… node --test tests/integration/c-payments-to-booking.test.mjs` | 3 subtests pass |
| Regression: Payments → Notifications, monolith → Notifications, contracts, Payments and Notifications suites | as in the earlier records | 6 / 4 / 16 pass; services 0 fail |
| Build and boot with a broker | `npx next build`; standalone `server.js` with temporary `DB_PATH` and `AMQP_URL` | Build OK; `/api/health` 200; log shows `broker relay started` and `event consumer started` ×2; broker lists one consumer each on `booking.events` and `ratings.events`; no error-level log lines |

Unit cases observed: a matching `payment.succeeded` marks the gateway booking paid and its redelivery is a duplicate (outcome `marked_paid` recorded once); a later different payment event for a paid booking is `already_paid`; amount mismatch and unknown order are recorded in `consistency_attention` without applying; a payment after the customer cancelled leaves the booking `cancelled`/`pending` with reason "refund required"; a forged producer and malformed data are permanent errors and leave no dedupe row; dedupe is per consumer; `review.created` recomputes the rating aggregates and its redelivery is a duplicate.

End-to-end cases observed: after `settleWebhook` in Payments the monolith order stayed `pending` until one relay pass, then became `paid` with one `processed_events` row; a republish of the same event was logged as a duplicate skip with no attention rows; a `payment.succeeded` claiming `producer = monolith` reached `booking.events.dlq`.

Not run: Compose and `tests/gateway` (images unavailable); real Keycloak; the saga (settlement eligibility is still a test stub).
