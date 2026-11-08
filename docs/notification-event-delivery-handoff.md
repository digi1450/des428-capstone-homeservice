# A step 5B — legacy notification relay retirement preparation

8 November 2026; based on main `d7a80fa` after provider writer preparation #41.
This is a disabled-by-default process selection and tested replacement path,
not an executed writer/data/queue/routing handover. See [step-5 audit](a-step5-caller-audit.md),
[provider writers](provider-event-writes-handoff.md), [reader composition](notifications-callers-handoff.md)
and [data cutover runbook](data-cutover-handoff.md).

## Selection and source ownership

`bangkok-homeservice/lib/modules/notifications/relay.js` now exports:

```js
configureNotificationEventDelivery({mode: 'events'});
```

Only explicit `events` is accepted; invalid mode changes nothing and replacement
is rejected. Selection stops an already-started inherited timer. Later calls to
`startRelay()` or `runRelayOnce()` cannot restart or manually drain that local
path; the latter returns 0 before querying or claiming any outbox row. The getter
exposes the selection. The reset helper is for tests/coordinated shutdown only;
it does not start a timer and must never be used as outage fallback while serving.

The existing default remains unchanged: `instrumentation.js` starts the legacy
relay, which creates SQLite notifications and recomputes ratings. No bootstrap,
environment flag, C consumer implementation, schema, package or root Compose is
changed here. A process-local selection neither verifies readiness nor controls
other running processes. Final startup must choose the reviewed mode in every
relevant process before accepting traffic, with old processes drained/stopped.

After selecting events, C's existing broker relay publishes the durable monolith
outbox. Notifications owns the notification effect in PostgreSQL; C's
`ratings.reviews` consumer remains in the monolith and recomputes both Catalog
service and Provider aggregates from the monolith's reviews. Each inbox has its
own transaction/dedupe record for the same event UUID. A Notifications dedupe or
outage cannot suppress the separate ratings effect. No rating data/SQL moves
into Notifications, and no second ratings implementation/store is added.

## Marker and migration boundaries

`processed_at` belongs to the old in-process relay; `published_at` belongs to C's
broker relay. Event mode does **not** claim/stamp local events, fabricate past
success, seed consumer dedupe or mark history as delivered. C's ratings inbox
updates its own `processed_events` row, not the old `events.processed_at`.

The offline exporter still rejects unprocessed legacy events. Therefore freeze,
reconcile/drain the legitimate old delivery boundary and snapshot it BEFORE the
new ownership switch, with C/E's reviewed event watermark and durable queue
handover. After event-mode writes, rows can legitimately retain null local
`processed_at`; do not run the old relay or stamp them just to pass an exporter.
A future export of an already-cut-over system needs a separately reviewed
migration/checkpoint procedure. This PR does not implement that procedure or
provide an online delta-sync. Published rows alone do not prove all consumer
effects; inspect each inbox/attention/DLQ as appropriate.

## Whole-flow activation gates

- Combine this with #40 remote readers and #41 provider approval/registration
  writer selection only after migrated inbox/wallet data and real B credentials
  are ready. This selector alone does not remove the direct approval writer.
- E/C must wire and verify broker publishing, durable bindings before publish,
  the monolith ratings/payment-status consumers and owning-service consumers.
  Notification downtime must retain durable pending work while ratings can
  progress independently. Readiness is not established by a config selector.
- Keep the still-local completion/refund/webhook and legacy payment.succeeded
  producer in the remaining A/C work. The monolith broker relay does not publish
  that inherited payment event as a substitute for Payments' owning outbox.
  Remote simulation/settlement and event-driven Booking paid status need their
  final coherent activation; never enable half a financial flow.
- Retain existing data/schema/seed and non-destructive startup safeguards.
  Never replay historical events as fresh notifications, wipe dedupe, or switch
  the gateway/readers to empty PG data. Post-cutover rollback is data-aware;
  restoring only baseline nginx or the old timer is not safe recovery.

## Validation actually run

Source copies and independent disposable Docker resources; no useful data or
credentials, no host ports, no unrelated project start/stop.

- Full Node 20 monolith: **202 passed**, no failures/skips/cancellations. New
  tests preserve default local notification/rating behavior; test explicit mode,
  timer stop/restart prevention and manual-drain prevention with the local inbox
  table removed; assert event markers stay unchanged; use the real C ratings
  inbox to prove an effect failure rolls back dedupe and a retry recomputes both
  aggregates once. The failure is an injected SQLite trigger in an in-memory DB.
- Existing Node 22 Notifications + PostgreSQL 16 suite: **42 passed**, no skips.
- New `tests/integration/notification-event-delivery-boundary.test.mjs`:
  **4 passed**, no failures/skips/cancellations, with real SQLite business review,
  C broker relay, RabbitMQ 4.1 and actual monolith/Notifications consumers.
  The local notifications table is removed. Five event types (review, booking
  status, completion, bid acceptance and provider approval) deliver six notes,
  including atomic bid winner/loser projections. Ratings updates while Notes is
  stopped; Notes later consumes its queued messages. Restart/redelivery preserves
  six notes, five Notes dedupe records and one independent monolith rating record.
- Existing C consumer lifecycle faults against RabbitMQ 4.1: **5 passed**.
- Production standalone Next Docker build, document links and `git diff --check`
  passed. No live remote-configured Next/Keycloak, Jaeger, actual server/host
  crash, full resource/load or useful-data migration is claimed.

To reproduce with compatible installed dependencies, disposable owner database
and broker URLs:

```sh
npm test --prefix bangkok-homeservice
node --test tests/integration/notification-event-delivery-boundary.test.mjs
node --test tests/integration/c-consumer-lifecycle.test.mjs
```

The new boundary requires `TEST_NOTIFICATIONS_DATABASE_URL` and `TEST_AMQP_URL`;
without them it skips, which is not the recorded result. RabbitMQ 4.1 needs the
root stack's `frameMax=131072` URL option with the pinned client. Lifecycle tests
change/delete test queues: use a dedicated disposable broker. None of these
commands is a production activation command.
