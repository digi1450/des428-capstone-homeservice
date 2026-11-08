# E cross-service messaging tracing — 8 November 2026

Branch `feat/e-cross-service-tracing` includes E's Pact work (`46ff474`) and RabbitMQ workers/tracing (`3ad54ab`). A's follow-up synchronizes main `3e71748` and fixes the reviewed integration issues. No branch was force-pushed and no live routing/saga/auth cutover is enabled.

## Integration corrections

- Resolved the Notifications consumer conflict by retaining C's complete #35 lifecycle implementation: broker cancellation wakes the supervisor, early error handlers catch setup faults, partial resources are closed and the existing queue is not deleted automatically. E's processing span wraps parse/handle/ack inside the existing retry/DLQ policy. A thrown processing error reaches the span wrapper before the outer retry handler catches it, so failed processing is recorded as an error.
- Payments publishing now extracts the parent from the durable outbox headers using `ROOT_CONTEXT` before creating its producer span. It injects the child context into a copied carrier. A separate relay process can continue the originating trace; retry does not mutate saved headers or event identity. Missing/invalid context starts a new root rather than borrowing an unrelated ambient context. Notifications also extracts from `ROOT_CONTEXT` for isolation between deliveries.
- `.env.example` now contains `RABBITMQ_PASSWORD` and `RABBITMQ_UI_PORT`. Passwords must be URL-safe because Compose assembles AMQP URLs. These initialize a new broker volume; changing the environment does not rotate an existing broker user's password. No real credential is committed.

## Available versus remaining

E's Compose additions provide RabbitMQ 4.1 and the Payments outbox relay/Notifications consumer with OTel preloaded. The source includes Pact consumer/provider verification for both service boundaries. The actual default HTTP servers still fail closed without real B authentication/composition. The final monolith AMQP/saga/recovery wiring, wallet consumer, Keycloak, trace coverage for all other consumers, final readiness/migration ordering, full clean-clone boot and combined 8 GB measurement remain integration work.

The new test proves a saved request carrier -> real AMQP publish -> Notifications processing relationship, using a fixture envelope/inbox. It does not prove that every live HTTP business writer already captures and stages its request context, nor that the whole production business flow is one Jaeger trace. HTTP/PG spans from E's earlier slice and these messaging spans still need final-stack validation together.

## Recorded validation

Checks use copied source and independently named disposable Docker projects; no useful database, real credential or unrelated project was touched.

- Full monolith (Node 20, in-memory SQLite): **179 passed**, no failures/skips.
- Payments suite (Node 22, PostgreSQL 16 and RabbitMQ 4.1): **84 passed**, no failures/skips.
- Notifications suite (Node 22, PostgreSQL 16): **42 passed**, no failures/skips; includes its PostgreSQL inbox/business tests and new context tests.
- C broker lifecycle regressions: **5 passed** against RabbitMQ 4.1 after adding E tracing; wallet end-to-end: **1 passed**.
- New messaging boundary (Node 22): **1 passed** with an actual confirm publisher and actual Notifications consumer over RabbitMQ 4.1. The producer continues a fixture persisted request trace; the consumer has the same trace ID and the producer's span ID as parent; the saved carrier is unchanged. Initialize OTel before importing traced modules, matching `node --import ./src/tracing.js ...` in the workers.
- New context/error regressions total **9 tests**, included in the two service suites. They cover restored parent, stable trace/event identity on retry, fresh child span, immutable carrier, missing/invalid carrier isolation and propagated error recording. The same tests against E's original helpers fail, including the original trace-ID overwrite.
- Contracts/OpenAPI suite: **19 passed**.
- E's Pact command, built against this synced source with two disposable PG16 databases: **4 passed**, no failures/skips. This verifies real client/provider shapes with explicit auth doubles, not Keycloak.
- `docker compose --env-file .env.example -f docker-compose.yml config --quiet` and `git diff --check` passed. The example now satisfies RabbitMQ interpolation; replace its placeholder passwords before running an actual stack.

Commands from repository root (install each package's lockfile dependencies first):

```sh
npm test --prefix services/notifications
npm test --prefix services/payments-wallet
npm test --prefix contracts
node --test tests/integration/e-messaging-trace-boundary.test.mjs

docker compose -f docker-compose.pact.yml run --rm --build pact-tests
```

Service PostgreSQL cases require `TEST_DATABASE_URL` pointing to a disposable owning database. The messaging boundary requires `TEST_AMQP_URL` pointing to a disposable RabbitMQ broker; for RabbitMQ 4.1/amqplib 0.10.4 use the configured `frameMax=131072` query parameter. The new boundary skips without its explicit test URL; a skipped run is not the recorded result above. Lifecycle tests deliberately delete their disposable queues; never point them at useful infrastructure.

No live root-stack boot, full Jaeger business-trace inspection, `act` execution, browser interaction or final cutover is claimed. Existing Pact/CI configuration is retained; publishing this branch does not merge it into main.
