# C wallet provisioning — recorded validation, 7 November 2026

Branch `feat/c-wallet-provisioning` from `main` at `b4d0b46`. These are the commands and results actually observed. Node v22.23.4, local PostgreSQL 16 and RabbitMQ 3.12 on disposable databases and queues. No Docker and no Keycloak.

| Check | Command | Result |
|---|---|---|
| Wallet consumer | `TEST_DATABASE_URL=… TEST_AMQP_URL=… node --test test/wallet-consumer.test.js` in `services/payments-wallet` | 7 pass (10 after the review fixes, 5 consecutive runs) |
| Payments suite | `TEST_DATABASE_URL=… TEST_AMQP_URL=… npm test` | 64 pass, 0 fail (67 after the review fixes) |
| Monolith suite (incl. `provider.registered` relay test) | `npm test` in `bangkok-homeservice` | 129 pass, 0 fail |
| End to end | `TEST_PAYMENTS_DATABASE_URL=… TEST_AMQP_URL=… node --test tests/integration/c-monolith-to-wallet.test.mjs` | 1 pass |
| Regression | `c-monolith-to-notifications.test.mjs` | 4 pass |
| Contracts | `npm --prefix contracts test` | 17 pass |
| A importer | `import.test.mjs` on fresh `mig_n` / `mig_p` | 29 pass / 4 fail, **identical on `main` without this change** (the CLI dry-run case fails in this local environment). Not changed here |

Cases observed:

1. Registration writes `provider.registered` with `{ provider_id }` only. When the event insert is forced to fail, the provider row is not created either.
2. The first delivery creates one wallet with balance 0, and a redelivery is skipped as a duplicate. 5 concurrent deliveries give one dedupe row and one wallet.
3. A wallet that already exists (850 / 150) is kept unchanged.
4. A failure inside the effect leaves no dedupe row, and the next delivery applies it.
5. Wrong producer, an unsupported type, a string, zero or mismatched provider id, an extra field, or a `message_id` mismatch: permanent rejection. Over RabbitMQ the forged producer lands in `payments.events.dlq` and no wallet is created.
6. Consumer down: the event is retained in `payments.events` (count 1, no wallet). After restart it is applied once.
7. End to end: the provider registers while Payments is down, the relay publishes 1 event, and the queue holds it. When the consumer starts there is one wallet. Two republishes of the same `event_uuid` give 2 duplicate skips, still one wallet, and an empty DLQ.

## Review fixes (8 November 2026, A's review of `fdda920`)

- **Broker cancel:** `basic.cancel` (callback `null`) now resolves `closed` with `cancelled_by_broker`. The loop moved into `superviseWalletConsumer()` (the entrypoint uses it). It closes the old connection and channel, waits for the backoff, then subscribes again, which re-asserts the topology.
- **Setup errors:** error and close handlers are attached as soon as the connection and the channel exist, before any topology, prefetch or consume RPC. If setup fails, both are closed and the call throws `ConsumerSetupError` (topology is incompatible, e.g. 406). The supervisor logs it and retries. Nothing is ever deleted or recreated automatically.
- **Probe of A's two scenarios** (disposable RabbitMQ 3.12):

  | Scenario | Old code `fdda920` | New code |
  |---|---|---|
  | `payments.events` deleted (broker cancel) | `closed` still pending after 2 s | `closed` resolved |
  | Classic `payments.events.dlq` pre-declared | unhandled `'error'` event, exit 1 | `ConsumerSetupError` caught, process alive, existing queue kept, 0 connections left |

- **New regressions:**
  - After a queue deletion the supervisor starts a second subscription and processes a newly published event.
  - An incompatible DLQ rejects startup with no uncaught exception, and the supervisor keeps logging setup errors without exiting.
  - The restart test now waits for the duplicate to be acked before it closes. Closing earlier correctly requeued the unacked duplicate, which made the queue count flaky.
