# Area C messaging handoff — outbox, RabbitMQ, idempotent consumer (DRAFT v1)

Recorded 7 November 2026. Owner: C (Peerawit). Status: first cross-boundary flow implemented and tested against real PostgreSQL and RabbitMQ: Payments `payment.succeeded` → Payments outbox → RabbitMQ → Notifications inbox. Not yet wired into live traffic, root Compose, Keycloak or the Booking saga. Evidence: [validation record](validation/c-outbox-dedupe-2026-11-07.md).

## What exists

| Piece | Location | Behaviour |
|---|---|---|
| Envelope contract | `contracts/event-envelope.schema.json`, `contracts/fixtures/event-envelopes.json` | `event_id` (UUID, also the AMQP `message_id`), `event_type`, `schema_version`=1, `producer`, `occurred_at`, `aggregate_type`, `aggregate_id` (string), optional `saga_id`/`correlation_id`, `data`. No extra fields; trace context is NOT in the body |
| Payments outbox table | `services/payments-wallet/migrations/003_outbox.sql` | `outbox_events`: immutable envelope + trace headers, `published_at`, lease (`locked_by`/`locked_until`), `attempts`, `next_attempt_at`, `last_error` |
| Stage hook | `services/payments-wallet/src/messaging/outbox.js` → `createOutbox().stage(client, event, context?)` | Fulfils A's `stageEvent(client, event)` hook: INSERT with the caller's transaction client. Refuses to run without a client. Rejects payload keys that look like credentials/OTPs |
| Relay | `relayOnce()` + process `node src/outbox-relay.js` | Claims due rows with a short lease (own short transaction, `FOR UPDATE SKIP LOCKED`), publishes **outside** any DB transaction, marks published only after a broker confirm. Failures back off (2^attempts s, max 60 s) |
| Publisher | `src/messaging/publisher.js` | Confirm channel, `persistent`, `mandatory`. A returned (unroutable) or nacked message is a failure and stays in the outbox |
| Notifications dedupe table | `services/notifications/migrations/002_processed_events.sql` | `processed_events` PK `(consumer_name, event_id)` |
| Inbox | `services/notifications/src/messaging/inbox.js` | One transaction: `INSERT … ON CONFLICT DO NOTHING` dedupe row + A's `recordEvent(type, data, { client })`. Duplicate → no effect. Checks the expected producer per event type |
| Consumer | `src/messaging/consumer.js` + process `node src/event-consumer.js` | Ack only after commit. Permanent error (bad envelope, unsupported type, wrong producer, invalid data) → reject → DLQ. Transient error → wait, requeue; quorum queue dead-letters after `x-delivery-limit` (default 5) |

Environment variables: both processes need `DATABASE_URL` (own service only) and `AMQP_URL`. Optional: `RELAY_POLL_MS`, `RELAY_BATCH_SIZE`, `RELAY_LEASE_MS`, `CONSUMER_PREFETCH`, `CONSUMER_DELIVERY_LIMIT`, `CONSUMER_RETRY_DELAY_MS`. Placeholders are in each `.env.example`.

## RabbitMQ topology (DRAFT — E please confirm names)

| Name | Type | Declared by |
|---|---|---|
| `homeservice.events` | durable topic exchange; routing key = `event_type` | producer and consumer |
| `notifications.events` | quorum queue, bound to the six event types Notifications maps, `x-delivery-limit`, DLX below | Notifications consumer |
| `homeservice.dead-letter` → `notifications.events.dlq` | direct exchange (routing key = source queue name) → quorum queue; each consumer gets its own DLQ | Notifications consumer |

Publish-subscribe: another consumer (e.g. the monolith Booking paid-flag or Ratings consumer) binds **its own** queue to the same exchange and uses its own `consumer_name`, so one consumer's dedupe never suppresses another.

Start order matters once: a consumer must have declared its queue before events are published, otherwise `mandatory` returns them and they stay pending in the outbox (safe, retried with backoff) rather than being lost.

## Requests to teammates

- **A**: (1) pass `stageEvent: createOutbox().stage` when you wire the Payments settlement route; (2) review the importer pin change in `tools/data-migration/import-snapshot.mjs` — the new C tables start empty after import, no legacy events are copied; (3) settlement eligibility `assertSettlementAllowed` is **not** in this PR — it needs Booking saga state and comes with the saga work.
- **D**: `event_id` is the message dedupe key; HTTP idempotency keys are separate. Let's agree that a stable command id can become `saga_id`/`correlation_id` rather than reuse `event_id`.
- **E**: run `node src/outbox-relay.js` (Payments image) and `node src/event-consumer.js` (Notifications image) as separate Compose services next to RabbitMQ. Trace context: `stage(client, event, { traceparent, tracestate, requestId })` stores them and the relay sends them as AMQP headers `traceparent`, `tracestate`, `x-request-id`; the consumer does not yet continue the span.
- **B**: these processes use no end-user tokens. The broker credential is a service credential; please include it in the secrets plan.

## Not done yet (next C work)

Monolith (SQLite) outbox for `booking.status_changed` and the other inherited events, Booking consumer for `payment.succeeded`, the Booking-orchestrated saga with compensation and recovery worker, `assertSettlementAllowed`, payment command/cancel fences, and legacy event watermark at cutover.
