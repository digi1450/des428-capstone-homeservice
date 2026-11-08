# A step 5B — provider lifecycle writer preparation

8 November 2026; based on main `29c896d` after Notifications readers #40.
This adds a selectable writer path for **provider signup wallets and approval
notifications only**, not all payment/notification writers or a live cutover.
See [caller audit](a-step5-caller-audit.md), [reader composition](notifications-callers-handoff.md)
and [selected wallet decision](payment-participant-decisions.md).

## What changes

`bangkok-homeservice/lib/modules/providers/event-writes.js` exports
`configureProviderEventWrites({mode:'events'})`, `getProviderEventWrites()` and
`resetProviderEventWrites()`. Missing/other mode is rejected before state changes;
replacement is rejected. Configuration is an explicit process-local selection,
not a credential, readiness check or proof that a remote system is available.
There is no environment auto-enable or HTTP parameter selecting it. Reset is
for tests/coordinated shutdown, never an outage fallback while traffic is live.

With no configuration, registration and approval retain their inherited SQLite
wallet/notification writes and existing public responses. In events mode:

- `identity/service.js:registerProvider` writes provider, profile and C's existing
  `provider.registered` event in the same SQLite transaction, without inserting
  `provider_wallets`. Payments' existing wallet consumer creates its own wallet.
- `providers/service.js:approveProvider` writes the approval flag and C's existing
  `provider.approved` event together, without inserting local `notifications`.
  Notifications' existing consumer owns the eventual approval notification.
- Events remain provider-ID-only with their existing event UUID/type/schema.
  No duplicate event protocol, new outbox/store, schema or dependency is added.
  No network request occurs inside either transaction. An outbox insert failure
  rolls back the associated provider/profile or approval state.
- Registration response stays 201 with its existing ID/email/name projection;
  approval response remains the existing approved profile. An event committed
  does not mean a wallet/notification has already been delivered. Existing remote
  wallet readers distinguish pending provisioning from a verified zero balance.
  Duplicate signup/approval retains the existing 409 behavior; it does not
  silently create a second account or a second logical registration event.

## Activation is still gated

No production startup, route, seed or service configuration calls this selector.
It is preparation for A/B/C/E's coordinated switch, not authorization to enable
it independently:

1. B coordinates actual signup/identity mapping and reviewed end-user credentials
   for both APIs and Server Components. Configure the reviewed remote readers
   and real service verifiers coherently with migration, not against an empty PG
   inbox or wallet database.
2. C/E enable monolith durable broker publishing and Payments wallet consumer,
   Notifications consumer and migration/readiness ordering. Root Compose does
   not yet contain all these final-stack processes/settings. Set up durable
   bindings before publishing and preserve pending work/dedupe under recovery.
3. A/C retire **remaining** financial SQLite writers, particularly completion
   and refund, before selecting this as a production ownership transition.
   Those writers can still expect a local wallet today. Merely skipping signup
   wallet creation while allowing those legacy operations is not safe cutover.
4. The inherited notification relay still writes other notifications and rating
   aggregates; this selector does not stop it. Coordinate notification/event
   watermark and data handover, retaining C's monolith-owned ratings consumer.
5. Imported/seeded providers need the reviewed snapshot/provisioning boundary.
   Do not replay old registration/approval history as new events, delete dedupe
   state, reset wallet balances, or remove migrated SQLite tables/schema guards.

Future startup should select the reviewed overall mode once, before requests,
only after these whole-flow gates. Do not dynamically toggle per request or
restore legacy mode because RabbitMQ/PG is down. Operator treatment of pending
or dead-lettered provisioning and final-stack evidence remains integration work.

## Validation actually run

Source copies and independently named disposable Docker resources; no host ports,
useful databases, real credentials or unrelated project changes.

- Node 20 full monolith: **197 passed**, no failures/skips/cancellations. New
  writer tests cover legacy responses/effects, explicit config, event-mode
  operation with SQLite wallet/notification tables removed, transaction rollback
  on registration/approval outbox failure, and duplicate logical-event rejection.
- Node 22 service suites with PostgreSQL 16 and RabbitMQ 4.1: Notifications
  **42 passed**, Payments **90 passed**, no failures/skips/cancellations.
- New `tests/integration/provider-event-writes-boundary.test.mjs`: **5 passed**,
  no failures/skips/cancellations. Actual Next route handlers -> SQLite domain
  transaction -> C broker relay -> RabbitMQ 4.1 -> real C consumers -> separate
  PG16 owner databases. Both moved SQLite tables are dropped in the fixture.
  Durable queue bindings are established, consumers stopped, then registration
  and approval commit. A deliberately failing publisher fixture leaves stable
  events pending; retry publishes to real broker while consumers stay stopped.
  Starting consumers produces one wallet and one approval notification. After
  stopping/restarting consumers, duplicate delivery preserves an explicitly
  altered test wallet balance/commission and notification read timestamp.
- Production standalone Next Docker build and `git diff --check` passed.

The publish-failure case is an injected publisher exception, not an actual broker
server outage. Consumer stop/start is real, but is not a full process/host restart
or crash-recovery proof. HTTP handlers use inherited test JWT auth, not Keycloak.
This test does not prove B auth, final distributed tracing, all remaining writers,
real data cutover, final-stack readiness, resource limits or all Area A completion.

With compatible installed dependencies and disposable test infrastructure:

```sh
npm test --prefix bangkok-homeservice
node --test tests/integration/provider-event-writes-boundary.test.mjs
```

The boundary requires `TEST_PAYMENTS_DATABASE_URL`,
`TEST_NOTIFICATIONS_DATABASE_URL` and `TEST_AMQP_URL`; otherwise it skips. Use
RabbitMQ 4.1 with the root stack's `frameMax=131072` URL setting. It establishes
real owner schemas/queues and can change broker topology, so never use live
URLs. A skipped run is not the recorded evidence.
