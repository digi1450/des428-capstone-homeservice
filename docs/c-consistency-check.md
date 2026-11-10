# C consistency check (cutover rehearsal, rollback, incidents)

`tools/consistency/c-check.mjs` is a **read-only** checker for Area C state across the owners. It never writes, publishes, acks or repairs anything:

- the SQLite file is opened `readonly` in one read transaction;
- Payments PostgreSQL is read in one `REPEATABLE READ READ ONLY` transaction;
- RabbitMQ is touched only through passive `checkQueue`.

```sh
node tools/consistency/c-check.mjs \
  --sqlite /path/to/booking.sqlite \
  --payments-url "$PAYMENTS_READONLY_URL" \
  [--notifications-url "$NOTIFICATIONS_READONLY_URL"] [--amqp-url "$AMQP_URL"] \
  [--mode report|quiescent] [--json]
```

The same options can be given as `C_CHECK_SQLITE`, `C_CHECK_PAYMENTS_URL`, `C_CHECK_NOTIFICATIONS_URL` and `C_CHECK_AMQP_URL`. Use read-only credentials, and never put real URLs or passwords in commits or evidence.

| Exit | Meaning |
|---|---|
| 0 | No violation, and in `quiescent` mode also no attention or pending items |
| 1 | At least one **violation** (in any mode) |
| 2 | `quiescent` mode only: attention or pending work remains |
| 3 | Usage error or an unreadable source (never a pass) |

## What it checks

- **Pending** (in-flight work that converges by itself):
  - unpublished monolith/Payments outbox rows;
  - running sagas and unconfirmed activations;
  - pending financial work or commands;
  - created-but-not-activated provisioning;
  - undelivered queue messages;
  - a charge that Booking has not applied yet.
- **Attention** (needs a recorded human decision):
  - open `consistency_attention` rows (unresolved);
  - `RECOVERY_PENDING` sagas;
  - activation `reconcile`, or `blocked` on a non-cancelled booking;
  - financial work or commands in attention;
  - dead letters in any `*.dlq`;
  - a missing consumer queue.
- **Violation** (a C invariant is broken):
  - holds kept on a cancelled or completed booking;
  - completion work on a booking that is not completed;
  - a ready cancellation on a booking that is not cancelled, or a cancelled booking whose cancellation is still pending;
  - an activated setup without a COMPLETED saga;
  - an order charged, refunded or credited more than once;
  - a refund without a charge, or both a payout and a refund;
  - intent status that disagrees with the charge ledger;
  - a fenced order that kept money or has accounting, or a fence that says refunded with no refund row;
  - a ready cancellation without a fence, or a ready completion without accounting;
  - a negative wallet;
  - **cross-service** contradictions:
    - a Payments command that Booking has no work for;
    - Booking work that is ready while Payments is not;
    - a refund flag that disagrees between the two;
    - a saga-owned booking marked paid without a charge;
    - a cancelled saga booking whose charge was not refunded and has no open reconciliation.

The SQLite and PostgreSQL snapshots come from different databases. For cutover evidence, run it with writers stopped and `--mode quiescent`. During normal operation `report` mode is the right one: in-flight work is expected.

## Intended use in the rehearsal (A/D/E)

1. **Before freeze:** `report` mode. Resolve every violation and attention item, and record the decisions.
2. **After writers stop, before backup/export:** `quiescent` mode must exit 0. Nothing may be pending, queued or dead-lettered.
3. **After import/apply, and after any rollback:** run again on the restored or new owners and keep the JSON as evidence.

Validation: `tests/integration/c-consistency-check.test.mjs`, recorded in `docs/validation/c-consistency-check-2026-11-10.md`.
