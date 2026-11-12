# C/D financial race acceptance over real HTTP — recorded validation, 12 November 2026

Branch `feat/c-financial-race-acceptance` from `main` at `754e8e0`. These are the commands and results actually observed. Node v22, local PostgreSQL 16 (disposable), in-memory SQLite for the Booking scenario. Auth is an explicit fixture verifier: B's real Keycloak verifiers are covered by the authenticated-stack suites, not here.

```sh
TEST_PAYMENTS_DATABASE_URL=… C_RACE_ROUNDS=20 node --test tests/integration/c-financial-race-acceptance.test.mjs
```

Every request is a real concurrent HTTP call into A's Payments router: strict v1/v1.1 validation, C financial operations, the settlement gate and PostgreSQL advisory locks.

- Each scenario runs 20 rounds. Rounds alternate which side starts first, with a random 0–6 ms head start, so both orders actually occur.
- Scenarios run for **new** (saga-provisioned) and **legacy** (approved import binding) bookings.
- After all rounds, the read-only C checker (`tools/consistency/c-check.mjs`) runs on Payments.

## Results (2 consecutive full runs, 13 pass / 0 fail each)

Observed outcome counts (run 1 / run 2). Every listed outcome satisfies the asserted invariant.

| Scenario | Invariant asserted every round | new | legacy |
|---|---|---|---|
| webhook × cancellation (unpaid) | fence always; `voided` ⇒ webhook 409 and no ledger; `refunded` ⇒ exactly charge + refund | voided 8/7, refunded 12/13 | voided 9/10, refunded 11/10 |
| completion × cancellation (paid) | never both payout and refund; at most one each; one charge | complete ready + cancel `completion_accounted` 12/10; cancel refunded + complete `cancellation_fenced` 8/10 | 11/11 and 9/9 |
| 2 duplicate + 1 distinct webhook × cancellation | ≤1 charge, ≤1 refund, charges = refunds (a fenced booking keeps no money) | refunded 19/20, voided 1/0 | refunded 18/20, voided 2/0 |
| webhook × completion | a pending (202) completion never pays out; a same-key retry gives exactly one charge + one payout | first 202: 10/7, first 200: 10/13 | 9/10 and 11/10 |
| same cancellation key ×3 concurrently | all 200, one effect, identical content | voided 10, refunded 10 | voided 10, refunded 10 |
| Booking: customer cancel × provider start (one process, interleaved, real Payments HTTP) | cancelled ⇒ start refused and holds released; started ⇒ cancel refused and the hold kept | cancelled 10, started 10 (both runs) | — |

Checker after all rounds: **0 violations**. The attention findings are the durably recorded race losers (`completion_accounted`, `cancellation_fenced`), and pending is provisioning created in setup. These are expected, not defects.

## Observation (not a defect)

The first version of the "same key ×3" assertion compared raw JSON text and failed. The fresh response and the replays have **identical content but different key order**, because the replay is read back from a PostgreSQL `JSONB` column, which normalizes key order. JSON object key order carries no meaning, and A's client validates structure, so the test now compares canonical (sorted) JSON. If byte-identical replay is ever required, store the result as text; no change was made.

## Limits

- Fixture auth only; no Keycloak in this run.
- The Booking scenario runs in one Node process: SQLite transactions are interleaved by the event loop, not truly parallel.
- No process crash in these runs. E's #61 already covers crash/redelivery and financial recovery; this suite does not duplicate it.
- D: map these to your required fault list and retry budgets. The numbers above are observations from 2 runs, not a probability claim.
