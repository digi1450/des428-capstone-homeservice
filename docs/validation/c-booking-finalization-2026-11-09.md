# C Booking finalization (monolith, step 5C) — recorded validation, 9 November 2026

Branch `feat/c-booking-finalization`, stacked on `feat/c-financial-operations` (#48). These are the commands and results actually observed. Node v22, in-memory SQLite, local PostgreSQL 16, disposable. Auth is an explicit fixture verifier; no Keycloak.

| Check | Command | Result |
|---|---|---|
| Finalization (A routes + C callbacks, scripted Payments) | `node --test test/booking-finalization.test.js` | 13 pass |
| Upgrade path (2 steps) | `node --test test/startup-upgrade.test.js` | 6 pass |
| Monolith suite | `npm test` in `bangkok-homeservice` | 228 pass, 0 fail |
| End to end (A routes → C → A client HTTP → A router → C Payments ops → PG) | `TEST_PAYMENTS_DATABASE_URL=… node --test tests/integration/c-booking-finalization-e2e.test.mjs` | 6 pass, 2 consecutive runs |
| A exporter (new guard + test) | `python3 -m pytest -q` in `tools/data-migration` | 17 pass |
| Real old files | DBs written by the code at `b4d0b46` and at `a23b98e`, each started twice with this branch | `6c9ccb3f` → `6a323e7e` and `7bce7dfa` → `6a323e7e`; first start `upgraded`, then `preserved`; customers 3 → 3; work 0 |

Cases observed:

1. COD completion is a single transaction: completed, work saved, one `booking.completed` event, no SQLite ledger or wallet change, accounting `ready`. The replay is not re-sent, and a wrong OTP on replay gets 409.
2. Payments unknown, then a lost reply, then success: 200 completed with accounting pending → ready, one command id, 3 calls.
3. Gateway completion uses the saga's provisioning refs. `awaiting_settlement` twice, then ready; no attention row.
4. A legacy gateway booking without a saga gets 409, the order stays `started`, and there is no work or event. A forced work-insert failure gives 500 with the completion and its events rolled back.
5. Pending cancellation returns 202 with the order still `awaiting` and the hold kept. Confirm is refused, and a repeated request creates no second work row. Voided then finalizes: cancelled, holds 0, one status event, replay 200 `refunded:false`, one command id.
6. A refunded outcome gives `payment_status` refunded with no SQLite ledger row. A paid booking with a no_payment outcome goes to attention and nothing is released.
7. Attention and coded `FINANCIAL_OPERATION_BLOCKED`: recorded once and not retried, holds kept, start refused.
8. 3 unknowns leave the work pending with one `financial outcome unconfirmed` row. A 401 is recorded immediately.
9. Stale worker: worker A's late ready after B's claim is discarded and B's lease is kept. B finalizes once.
10. A pending cancellation blocks completion, and a completed booking cannot be cancelled.
11. End to end:
    - COD commission once; replay adds nothing.
    - Gateway pending, then settle and recovery give `charge + payout_credit`.
    - Unpaid cancellation is voided and holds are released; a late webhook gets 409 with no charge.
    - Paid cancellation gives `charge + refund` and the booking becomes refunded.
    - With Payments stopped the cancellation is 202, the order is still awaiting and the hold is kept. After restart, recovery gives cancelled with holds 0, and there is exactly one Payments command (ready).
