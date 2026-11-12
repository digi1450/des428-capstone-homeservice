# Area C — evidence index (for review and defence)

Owner: Peerawit Amnartpanich. This is a **factual map** from each Area C responsibility to its code, tests, recorded runs and the lecture material it applies. It contains no defence reasoning; the owner writes that from this evidence. Numbers are copied from the dated validation records, which remain the source of truth.

## 1. Responsibilities → implementation → evidence

| # | Responsibility | Main code | Tests | Recorded evidence | PRs | Lecture |
|---|---|---|---|---|---|---|
| 1 | **Transactional outbox + relay** (Payments PG and monolith SQLite), lease, publisher confirms, `mandatory` | `services/payments-wallet/src/messaging/outbox.js`, `src/outbox-relay.js`; `bangkok-homeservice/lib/messaging/broker-relay.js` | `services/payments-wallet/test/outbox.test.js`, `bangkok-homeservice/test/broker-relay.test.js`, `tests/integration/c-outbox-to-notifications.test.mjs` | [c-outbox-dedupe](validation/c-outbox-dedupe-2026-11-07.md), [c-monolith-outbox](validation/c-monolith-outbox-2026-11-07.md); kill demo `tests/integration/c-relay-kill-demo.sh` (committed 8, pending 5 → 0 after restart, notifications 8) | [#14](https://github.com/digi1450/des428-capstone-homeservice/pull/14), [#15](https://github.com/digi1450/des428-capstone-homeservice/pull/15) | W8 slides 20–31; W9 slides 28–31 |
| 2 | **RabbitMQ topology** — topic `homeservice.events`, quorum queues, delivery limit, per-queue DLQ via `homeservice.dead-letter` | `*/messaging/topology.js`, `bangkok-homeservice/lib/messaging/consumers.js` | consumer tests per service | [c-outbox-dedupe](validation/c-outbox-dedupe-2026-11-07.md) (bad/forged → DLQ) | #14, #16 | W9 slides 21–27 |
| 3 | **Idempotent consumers** — `processed_events(consumer, event_id)` written in the effect's transaction; ack after commit | `services/notifications/src/messaging/inbox.js`, `bangkok-homeservice/lib/messaging/inbound.js`, `services/payments-wallet/src/messaging/wallet-consumer.js` | `tests/integration/c-monolith-to-notifications.test.mjs`, `c-payments-to-booking`, `c-monolith-to-wallet` | duplicates → 1 effect; 5 concurrent → 1 effect ([c-outbox-dedupe](validation/c-outbox-dedupe-2026-11-07.md), [c-wallet-provisioning](validation/c-wallet-provisioning-2026-11-07.md)) | [#16](https://github.com/digi1450/des428-capstone-homeservice/pull/16), [#30](https://github.com/digi1450/des428-capstone-homeservice/pull/30) | W9 slides 21–31; W3 slides 28–31 |
| 4 | **Consumer lifecycle** — broker cancel and setup errors never leave a silent dead consumer | same consumer files | `tests/integration/c-consumer-lifecycle.test.mjs` | [c-consumer-lifecycle](validation/c-consumer-lifecycle-2026-11-08.md) (main 0/5 → fix 5/5) | [#35](https://github.com/digi1450/des428-capstone-homeservice/pull/35) | W9 |
| 5 | **Booking-orchestrated saga** — provisioning, compensation (fence first), unknown ≠ failure, lease, recovery | `bangkok-homeservice/lib/modules/booking/saga.js` | `bangkok-homeservice/test/booking-saga*.test.js`, demo `tests/integration/c-saga-demo.mjs` | [c-booking-saga](validation/c-booking-saga-2026-11-07.md) (CANCELLED, holds 3 → 0, retry 409, rebook 201) | [#17](https://github.com/digi1450/des428-capstone-homeservice/pull/17) | W10 slides 11–25, 51–66 (slide 57's four questions) |
| 6 | **Payments participant** — command store, absent-create fence, activation, settlement eligibility | `services/payments-wallet/src/participant/index.js`, migration 004 | `services/payments-wallet/test/participant.test.js` | [c-payment-participant](validation/c-payment-participant-2026-11-07.md) (12-round activate/cancel/settle race, never fence + charge) | [#24](https://github.com/digi1450/des428-capstone-homeservice/pull/24)/[#25](https://github.com/digi1450/des428-capstone-homeservice/pull/25), [#27](https://github.com/digi1450/des428-capstone-homeservice/pull/27) | W8 saga; W4 section 05 (ownership/transactions) |
| 7 | **Saga activation delivery** + reviewed SQLite upgrade path | `saga.js` (activation), `lib/db/migrate.js` `UPGRADES` | `booking-saga-activation.test.js`, `startup-upgrade.test.js` | [c-monolith-activation](validation/c-monolith-activation-2026-11-07.md) (stale-lease and coded-409 regressions) | [#29](https://github.com/digi1450/des428-capstone-homeservice/pull/29) | W10 recovery |
| 8 | **Wallet provisioning** via `provider.registered` | `identity/service.js` event + wallet consumer | `wallet-consumer.test.js`, `c-monolith-to-wallet` | [c-wallet-provisioning](validation/c-wallet-provisioning-2026-11-07.md) | [#30](https://github.com/digi1450/des428-capstone-homeservice/pull/30) | W8/W9 |
| 9 | **Financial finalization (step 5C)** — Payments operations, order fence, payout only after charge, refund once | `services/payments-wallet/src/financial/index.js`, migration 005 | `financial-operations.test.js` | [c-financial-operations](validation/c-financial-operations-2026-11-09.md) (20-round races both orders) | [#48](https://github.com/digi1450/des428-capstone-homeservice/pull/48) | W8/W10; W3 idempotency |
| 10 | **Booking financial work, guards, recovery** — complete/cancel keep holds until Payments confirms | `bangkok-homeservice/lib/modules/booking/finalization.js` | `booking-finalization.test.js`, `tests/integration/c-booking-finalization-e2e.test.mjs` | [c-booking-finalization](validation/c-booking-finalization-2026-11-09.md) (Payments down → converges to one command) | [#49](https://github.com/digi1450/des428-capstone-homeservice/pull/49), [#50](https://github.com/digi1450/des428-capstone-homeservice/pull/50) | W10 slides 51–66 |
| 11 | **Legacy bookings after cutover** — C proposal, implemented by A | proposal `docs/c-legacy-binding-proposal.md`; A: `legacy-eligibility.js`, `legacy-binding.js`, migration 006 | A: `legacy-eligibility.test.js`, `legacy-v11-boundary.test.mjs` | [legacy v1.1 handoff](legacy-v11-integration-handoff.md) | [#60](https://github.com/digi1450/des428-capstone-homeservice/pull/60) (C), A: #62–#77 | — |
| 12 | **Read-only consistency checker** | `tools/consistency/c-check.mjs` (A added broker check and fixes) | `tests/integration/c-consistency-check.test.mjs` | [c-consistency-check](validation/c-consistency-check-2026-11-10.md); used in [actual local cutover](validation/a-local-cutover-2026-11-12.md) | [#59](https://github.com/digi1450/des428-capstone-homeservice/pull/59), A [#78](https://github.com/digi1450/des428-capstone-homeservice/pull/78) | — |
| 13 | **Joint D/C financial race acceptance** over real HTTP (new + legacy) | — (test only) | `tests/integration/c-financial-race-acceptance.test.mjs` | [c-financial-race-acceptance](validation/c-financial-race-acceptance-2026-11-12.md) (2 × 20 rounds per scenario, checker 0 violations) | [#81](https://github.com/digi1450/des428-capstone-homeservice/pull/81) (open) | W10 / D faults |

Team-level evidence that includes C paths: [authenticated 16-service stack](validation/a-e-final-stack-2026-11-10.md), [E crash/redelivery and recovery](validation/e-task5-fault-recovery-2026-11-10.md), [actual local cutover](validation/a-local-cutover-2026-11-12.md).

## 2. Demos that already exist

| Demo | Command | What it shows |
|---|---|---|
| Relay kill | `sh tests/integration/c-relay-kill-demo.sh` | Kill the relay mid-stream; nothing is lost, and restart drains to zero pending |
| Saga compensation | `node tests/integration/c-saga-demo.mjs` | Payment setup fails → booking cancelled, holds released, idempotent retry |
| Consistency check | `node tools/consistency/c-check.mjs --sqlite … --payments-url … --mode quiescent` | Invariants across owners; exit codes 0/1/2/3 |
| Race acceptance | `TEST_PAYMENTS_DATABASE_URL="${TEST_PAYMENTS_DATABASE_URL:?Set a disposable PG URL first}" C_RACE_ROUNDS=20 node --test tests/integration/c-financial-race-acceptance.test.mjs` | Concurrent webhook/complete/cancel never pays and refunds the same booking |

Before the race command, install the locked monolith and Payments dependencies
and set `TEST_PAYMENTS_DATABASE_URL` to a **fresh disposable PostgreSQL database**
with schema-creation permission. Never use the live owner database. Fail explicitly
if the variable is absent, then run the suite:

```sh
npm ci --prefix bangkok-homeservice
npm ci --prefix services/payments-wallet
: "${TEST_PAYMENTS_DATABASE_URL:?Set a fresh disposable PostgreSQL URL first}"
C_RACE_ROUNDS=20 node --test tests/integration/c-financial-race-acceptance.test.mjs
```

Without that variable, the integration suite is opt-in and skips; a green process
exit alone is not race evidence. After PR81's review correction, a complete local
run has14 passing tests, including the negative cancellation-evidence regression,
and zero skips. The original13-test records remain historical. CI now invokes the
suite explicitly after the earlier financial boundaries; check the new head's
GitHub result separately. Merge this evidence index after PR81 so its two new file
references exist. These tests do not close all D faults/retry budgets or defence.

## 3. Questions to prepare (owner answers from the evidence above)

- Why an outbox instead of publishing inside the request? What is lost without it? (#1)
- What does "at-least-once + idempotent consumer" guarantee, and what does it not? (#1, #3)
- Why is the dedupe row written in the same transaction as the effect, and what happens if the ack is lost? (#3)
- Why orchestration (Booking) rather than choreography for this saga? Answer slide 57's four questions for this system. (#5)
- Why is a timeout treated as "unknown", not as failure, and how does recovery resolve it? (#5, #7, #10)
- Why fence first and then cancel? What would go wrong in the opposite order? (#5, #6, #9)
- Why does completion leave accounting "pending", and why are slot holds kept until Payments confirms a cancellation? (#9, #10)
- Why do lease tokens need to be per claim and not per process? (#7 review fix)
- How do you know the system never both pays out and refunds? What evidence, and what are its limits? (#9, #13)
- What did a teammate's review catch in C code, and how was it fixed? (#29, #30, #48 follow-up, #78)
