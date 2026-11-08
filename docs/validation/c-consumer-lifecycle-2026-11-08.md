# C consumer lifecycle fix (Notifications + monolith) — recorded validation, 8 November 2026

Branch `fix/c-notifications-consumer-lifecycle` from `main` at `393d940`. This applies the two lifecycle faults A found in the wallet consumer (review on #30) to the two consumers already on `main`: Notifications (#14) and the monolith (#16). Node v22, local PostgreSQL 16 and RabbitMQ 3.12, disposable. No Docker and no Keycloak.

What changed (in both consumers):

- A `null` delivery (broker-initiated `basic.cancel`, for example when the queue is deleted) resolves `closed` with `cancelled_by_broker`.
- The reconnect loop closes the old connection and channel before it subscribes again. For Notifications this is the new `superviseConsumer()`, which the process entrypoint uses. For the monolith it is `startConsumers()`, which also cancels its backoff sleep on `stop()`.
- Error and close handlers are attached as soon as the connection and the channel exist, before any topology, prefetch or consume RPC. If setup fails, both are closed and the call throws `ConsumerSetupError` (for example 406 from an incompatible existing queue). Queues are never deleted or recreated automatically.

| Check | Command | Result |
|---|---|---|
| Lifecycle regressions | `TEST_AMQP_URL=… node --test tests/integration/c-consumer-lifecycle.test.mjs` | 5 pass, 3 consecutive runs. **The same file against `main`'s consumers: 0 pass / 5 fail** |
| Monolith suite | `npm test` in `bangkok-homeservice` | 161 pass, 0 fail |
| Notifications suite | `TEST_DATABASE_URL=… npm test` in `services/notifications` | 38 pass, 0 fail |
| Integration | `c-monolith-to-notifications`, `c-outbox-to-notifications`, `c-payments-to-booking` | 4 / 6 / 4 pass |

Cases observed for each consumer:

1. Deleting its queue resolves `closed` within 2 s.
2. Under the supervisor, deleting the queue again leads to a second subscription, and a newly published event is handled by it.
3. A pre-declared classic DLQ gives a `ConsumerSetupError` (PRECONDITION) with no uncaught exception, and the existing queue is still there.
