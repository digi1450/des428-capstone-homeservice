# Area E tracing and reliability checks

Run from the repository root. This Compose project has disposable PostgreSQL
and RabbitMQ storage, test-only credentials, and no host ports. Do not point
these tests at a useful database or broker: lifecycle tests delete test queues.

```sh
docker compose -f tests/e2e-tracing/compose.yml run --rm --build test-runner
docker compose -f tests/e2e-tracing/compose.yml run --rm --build reliability-test
docker compose -f tests/e2e-tracing/compose.yml run --rm reliability-test node --test services/payments-wallet/test/outbox.test.js
docker compose -f tests/e2e-tracing/compose.yml down --volumes
```

The reliability image defaults to C's consumer lifecycle suite; the third
command explicitly runs the PostgreSQL outbox suite. Run commands sequentially
because lifecycle checks deliberately change broker topology.

Use RabbitMQ 4.1 and `frameMax=131072`, matching the root stack. With the pinned
AMQP client, omitting that URL option negotiates 4096 bytes, below RabbitMQ 4.1's
8192-byte minimum, and the broker closes the connection.

## Evidence boundary

The tracing test makes real HTTP requests to a Payments server and uses actual
PostgreSQL, outbox relay, RabbitMQ and Notifications inbox implementations. It
asserts persisted request/trace context and the HTTP -> publish -> process span
parent chain, with one notification effect. Both applications and the relay
run inside a single test process with an in-memory span collector and explicit
authentication doubles.

This is not a production Keycloak/JWT test, a separate-process final stack boot,
a PostgreSQL span assertion, Jaeger export/UI evidence, or a measurement of the
combined 8 GB resource budget. The dedicated E tracing and reliability workflow now runs these suites
sequentially on PRs and main pushes. Final integration and delivery evidence remain
Area E work with A/B/C/D; merging this runner does not close those gates.

## Review validation — 8 November 2026

After aligning the broker and AMQP URL with the root stack, the commands above
passed on isolated PostgreSQL 16 and RabbitMQ 4.1: tracing **1/1**, lifecycle
**5/5**, outbox **9/9**, with no skips or cancellations. The tracing re-run
also delivered its own event while a previous interrupted run had left pending
rows; assertions stay scoped to the unique event and trace. No application code,
real data, runtime authentication or production routing was changed.

## CI entrypoint

Run `bash scripts/run-e-tracing-reliability.sh` from a Docker-enabled shell. It
creates a new `homeservice-e-ci-*` project, refuses one with existing containers,
requires nonzero tests and zero failures/skips in each TAP summary, and cleans up
only its own disposable project on success or failure. The workflow also cleans
up on cancellation. This does not enable root-stack auth, touch useful data or
prove a production Jaeger trace. See docs/e-task3-ci-handoff.md for act commands
and the contract coverage matrix.
