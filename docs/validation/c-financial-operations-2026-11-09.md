# C financial operations (Payments, step 5C) — recorded validation, 9 November 2026

Branch `feat/c-financial-operations` from `main` at `a23b98e`. These are the commands and results actually observed. Node v22, local PostgreSQL 16 and RabbitMQ 3.12, disposable. No Docker, no Keycloak; auth is an explicit test verifier.

| Check | Command | Result |
|---|---|---|
| Financial operations | `TEST_DATABASE_URL=… node --test test/financial-operations.test.js` in `services/payments-wallet` | 13 pass, 2 consecutive runs |
| Payments suite | `TEST_DATABASE_URL=… TEST_AMQP_URL=… npm test` | 113 pass, 0 fail |
| Contracts | `npm --prefix contracts test` | 30 pass |
| A integration | `a-payment-runtime-boundary`, `financial-finalization-boundary`, `payment-activation-http-boundary`, `payment-command-http-boundary`, `payments-boundary` | 6 / 4 / 5 / 3 / 1 pass |
| C integration | `c-payments-to-booking`, `c-monolith-to-wallet`, `provider-event-writes-boundary` | 4 / 1 / 5 pass |
| `payment-views-boundary` | same command | 2 pass / 3 fail, **identical on `main` without this change**. Not changed here |
| A importer (pin 005, new probes) | `import.test.mjs` on fresh `mig_n` / `mig_p` | 32 pass / 4 fail; the 4 are the CLI case, identical on `main` (30 / 4 before the probes) |
| A exporter | `python3 -m pytest -q` | 16 pass |

Every result in these cases was also checked with A's own `financialResult` validator:

1. Gateway completion before settlement is pending `awaiting_settlement` with no ledger rows, and a same-key retry stays pending. After activation and settlement the same key gives ready `payout_credit` 9630 (10700 − 1070); the replay is identical, the ledger is charge + payout_credit, and the wallet holds 9630. A lookup by another caller returns `null`.
2. COD gives `commission_owed` 1070. A changed request and a second key both get a coded `FINANCIAL_COMMAND_CONFLICT`, and the stored result is not overwritten.
3. Cancelling an unpaid gateway booking gives `voided` with a fence. A late settle gets 409 with no charge, a late activate gets coded `PAYMENT_SETUP_CANCELLED`, a late completion gets attention `cancellation_fenced`, and a second cancellation key gets a coded conflict.
4. Cancelling after settlement gives `refunded` once (charge + refund) and blocks activation.
5. Absent-create cancellation gives `no_payment`. A late create is fenced under the same or another key, and no intent is created. COD cancellation gives `no_payment`.
6. Cancellation after COD completion gives attention `completion_accounted` with no fence. Cancellation while a gateway completion is pending gets coded `FINANCIAL_OPERATION_BLOCKED`, is not stored, and the intent is not voided.
7. Wrong saga refs, or a wrong amount on completion, give `context_mismatch` and nothing is voided. A legacy intent without provisioning gives `legacy_reconciliation_required`.
8. With an injected `applyRefund` failure there is no command row, no fence and no refund. The same key then gives `refunded`.
9. Race: settle against cancel, 20 rounds, with alternating start order and a random 1–6 ms head start. Observed `voided/none` ×9 and `refunded/charge+refund` ×11. There was never an unrefunded charge after a fence.
10. Race: complete against cancel on a paid booking, 20 rounds. Observed `ready payout + cancel completion_accounted` ×10 and `cancel refunded + completion attention` ×10. There was never both a payout and a refund.
11. Through A's real router: COD completion 200, changed request 409 with code, pending 202, blocked cancellation 409 with code, voided cancellation 200, late completion 409 `cancellation_fenced`, GET 200, unknown GET 404.

Not done here: the monolith Booking callbacks and recovery (next C slice), B verifiers, server wiring, and the legacy eligibility gate.

## A review corrections and current candidate evidence — 9 November

This supersedes the earlier failures above for the checks actually rerun, while
preserving C's original observations and distinguishing fixture drift from code defects. Current candidate includes main
through D #47 and the two reviewed financial corrections; production remains unwired.

- New regressions on original C code: both child cases fail (different-key HTTP
  completion receives500; cross-order cancellation incorrectly returns ready).
- Corrected financial subset:15 pass. Full Payments suite:115 pass,0 fail/skip,
  Node22 with disposable PG16 and RabbitMQ4.1. Same-key replay, settlement/cancel
  and payout/refund races remain covered. No useful data or real auth is used.
- Actual runtime/financial/payment-view HTTP+PG boundaries:15 pass,0 fail/skip,
  Node20 native SQLite with Linux locked service dependencies. Payment-view
  baseline reproduced2 child failures on main; the fixture now controls automatic
  activation explicitly and production code is unchanged for that issue.
- Two-owner offline migration/importer:36 pass,0 fail/skip, PG16/Node22 including
  both CLI dry-runs. The earlier CLI failures were not reproduced in this isolated environment;
  no importer CLI, dependencies or useful databases were modified for those passes.
- D's integrated monolith218 pass and its actual stale-read regression red/green
  were observed before #47 merge; CI checks the whole final #48 candidate again.

Only the dedicated temporary projects/fixtures are removed. No real Keycloak,
Booking financial work/recovery, whole-stack restart/fault acceptance, resource
budget or legacy/cutover completion is claimed by these runs.
