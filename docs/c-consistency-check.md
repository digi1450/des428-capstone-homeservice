# C consistency check (cutover rehearsal, rollback, incidents)

`tools/consistency/c-check.mjs` is a **read-only** checker for Area C state across the owners. It never writes, publishes, acks or repairs anything:

- the SQLite file is opened `readonly` in one read transaction;
- Payments PostgreSQL is read in one `REPEATABLE READ READ ONLY` transaction;
- RabbitMQ uses passive `checkQueue` plus optional read-only management HTTP GETs for ready/unacknowledged counters. It never creates/purges queues or consumes/acks messages.

```sh
node tools/consistency/c-check.mjs \
  --sqlite /path/to/booking.sqlite \
  --payments-url "$PAYMENTS_READONLY_URL" \
  [--notifications-url "$NOTIFICATIONS_READONLY_URL"] \
  [--amqp-url "$AMQP_URL" --broker-management-url https://broker.example.test] \
  [--mode report|quiescent] [--json]
```

The same options can be given as `C_CHECK_SQLITE`, `C_CHECK_PAYMENTS_URL`, `C_CHECK_NOTIFICATIONS_URL` and `C_CHECK_AMQP_URL`; management uses `C_CHECK_BROKER_MANAGEMENT_URL`. Use read-only credentials, and never put real URLs or passwords in commits or evidence.

| Exit | Meaning |
|---|---|
| 0 | No violation, and in `quiescent` mode also no attention or pending items |
| 1 | At least one **violation** (in any mode) |
| 2 | `quiescent` mode only: attention or pending work remains |
| 3 | Usage error or an unreadable source (never a pass) |

## Review corrections and frozen-broker coverage

`quiescent` requires both SQLite and Payments sources. Both modes refuse missing
core C tables; Payments additionally requires the exact current migration names
and source checksums. Missing tables, changed/unknown versions or inaccessible
sources exit3, rather than skipping those invariants. This is not a substitute for
A's complete source schema/fingerprint and importer allow-list review.

Cross-owner financial checks compare the stable command ID, operation UUID and
immutable request, plus the full ready result. Matching only order/kind is not
sufficient after rollback or a mismatched restore.

Passive AMQP `messageCount` counts ready messages, not deliveries already held
unacknowledged by a consumer. Without management counters the checker records
`broker.unacknowledged.unknown`; it cannot return a quiescent pass for that broker.
Supply `--broker-management-url` (an HTTP(S) origin, no path/userinfo/query) on the
same hostname as the AMQP URL. Credentials/vhost come from the AMQP URL; redirects
are refused and requests have a5-second timeout. Prefer HTTPS and a dedicated
monitoring/read identity in an operator-controlled environment. The plain HTTP
address in the isolated test fixture is not a production credential example.

Management counters are sampled, not an atomic snapshot with either database.
**Freeze writers, drain and disconnect consumers, then wait for the broker's
statistics to refresh before the final check.** Ready or unacknowledged work,
attached consumers in quiescent mode, and missing queues **or DLQs** block passage.
Unreadable/permission-denied management or incomplete counters exit3; retry after
statistics become available. Do not use a concurrent live `report` result as a
cutover authorization: sequential owner snapshots can observe in-flight changes.

Broker/Notifications remain explicitly optional for owner-only/offline snapshot
reports. An exit0 for omitted sources does not verify those sources. Full cutover
acceptance must include the broker and the separate reviewed freeze/checkpoint.
Put real credentials in `C_CHECK_*` environment variables rather than CLI arguments
or logs. No automatic repair, migration, writer freeze or cutover is performed.

## What it checks

- **Pending** (in-flight work that converges by itself):
  - unpublished monolith/Payments outbox rows;
  - running sagas and unconfirmed activations;
  - pending financial work or commands;
  - created-but-not-activated provisioning;
  - ready or unacknowledged queue messages;
  - consumers still attached during frozen/quiescent validation;
  - a charge that Booking has not applied yet.
- **Attention** (needs a recorded human decision):
  - open `consistency_attention` rows (unresolved);
  - `RECOVERY_PENDING` sagas;
  - activation `reconcile`, or `blocked` on a non-cancelled booking;
  - financial work or commands in attention;
  - dead letters in any `*.dlq`;
  - a missing consumer queue or dead-letter queue;
  - unavailable unacknowledged-message coverage.
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
    - mismatching command IDs, operation IDs, request data or ready results;
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


## Reproducible regression suite

```sh
bash scripts/run-consistency-check-tests.sh
```

The runner builds current locked dependencies/source, creates a new disposable
SQLite/PG16/RabbitMQ4.1-management fixture, publishes/acks only its own synthetic
test messages, and cleans only that project. No host ports or persistent volumes.
The checker remains read-only; the test fixture deliberately writes/injects invalid
state. `.github/workflows/c-consistency-check.yml` runs this suite on PR/main.
A real16-service cutover/checkpoint/rollback snapshot still requires A/D/E acceptance.
