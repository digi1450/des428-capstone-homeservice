# C wallet provisioning — recorded validation, 7 November 2026

Branch `feat/c-wallet-provisioning` from `main` at `b4d0b46`. These are the commands and results actually observed. Node v22.23.4, local PostgreSQL 16 and RabbitMQ 3.12 on disposable databases and queues. No Docker and no Keycloak.

| Check | Command | Result |
|---|---|---|
| Wallet consumer | `TEST_DATABASE_URL=… TEST_AMQP_URL=… node --test test/wallet-consumer.test.js` in `services/payments-wallet` | 7 pass |
| Payments suite | `TEST_DATABASE_URL=… TEST_AMQP_URL=… npm test` | 64 pass, 0 fail |
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
