# C Payments participant — recorded validation, 7 November 2026

Branch `feat/c-payment-participant`. These are the commands and results actually observed. Node v22.23.4 and local PostgreSQL 16.15 on disposable databases; no Docker images and no Keycloak (the HTTP case uses an explicit test verifier double). Implements the agreed interface in [c-payment-participant-interface.md](../c-payment-participant-interface.md) (PRs #24/#25).

| Check | Command | Result |
|---|---|---|
| Participant cases | `TEST_DATABASE_URL=… node --test test/participant.test.js` in `services/payments-wallet` | 13 pass |
| Payments suite incl. A's command HTTP tests | `TEST_DATABASE_URL=… npm test` | 55 pass, 0 fail |
| A importer with the 004 pin and extended C-state guard | `import.test.mjs` with fresh `mig_n` / `mig_p` | 27 pass, 0 fail; exporter OK |
| Contracts | `npm --prefix contracts test` | 17 pass |
| Integration | `c-outbox-to-notifications`, `c-payments-to-booking`, `payment-command-http-boundary` | 6 / 4 / 3 pass |
| `payments-boundary.test.mjs` | `TEST_DATABASE_URL=… node --test tests/integration/payments-boundary.test.mjs` | **fails also on `main` without this change** (fresh DB, changes stashed): it expects `PaymentOutcomeUnknownError` with `createCommandId`/`lookup_missing` and receives a different unknown outcome. This is A's file, reported to A, and not changed here |

Participant cases observed:

1. Create: fresh `replayed=false`, then exact replay `replayed=true` with an identical result. Changed input, or the create id reused as a cancel id, gets 409. A second create identity for an already-bound booking gets 409. There is one intent.
2. Absent-create fence: `get` is `null` before. Cancel returns `cancelled`. The late create gets 409 `PAYMENT_SETUP_CANCELLED` and no intent row exists. Cancel replay works.
3. Create, then cancel, then replaying the create returns the identical historical result. There is still one intent (voided, `failed`), `get` is `cancelled`, activate gets 409 coded, and settlement is refused.
4. A cancel that names another saga gets 409 and the original provisioning stays `created`.
5. Settlement before activation is refused ("not settleable"). After activation (fresh, then replay) it succeeds and stages exactly one `payment.succeeded` outbox row. A later cancel gets 409 ("refund, not void") and the provisioning stays `activated` (no fence written).
6. Activating an unknown create, or with a saga mismatch, gives an uncoded 409. A create id reused as an activate id gets 409.
7. Cancel after activation voids the intent. Settlement is refused, and a replayed activate gets 409 coded.
8. A legacy intent with no provisioning row is not adopted: 409 and no provisioning row.
9. Race, 12 rounds of activate, cancel and `settleWebhook` concurrently (half pre-activated). Every round ended in a valid state. Last run: `activated/succeeded/charged` ×7 and `fenced/failed/none` ×5. No round had a fence together with a charge or a succeeded intent.
10. Scoping: another caller's `get` returns `null`.
11. Through A's real router: create 201, replay 200 identical, changed input 409, get `created`, unknown 404, cancel 200, and the historical create replay after the fence still passes A's strict result validation (200).

Deviation from the agreed DDL: `payment_provisioning.intent_id` is `UNIQUE` **without** a foreign key. A's importer truncates `payment_intents` during rollback tests, and an FK made it fail. The row is written in the same transaction as the intent.

Not done in this slice: `activate` HTTP route, coded-error serialization and client (A), monolith activation state/migration and recovery (C, next), wallet consumer (C, next; its `processed_events` table is included), real B verifier, live wiring.
