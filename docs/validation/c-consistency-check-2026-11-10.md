# C consistency checker — recorded validation, 10 November 2026

Branch `feat/c-consistency-check` from `main` at `9ad496a`. These are the commands and results actually observed. Node v22, local PostgreSQL 16 and RabbitMQ 3.12, disposable. The SQLite file is a temporary file built by A's real `migrate()` plus `seed()`.

| Check | Command | Result |
|---|---|---|
| Checker | `TEST_PAYMENTS_DATABASE_URL=… TEST_AMQP_URL=… node --test tests/integration/c-consistency-check.test.mjs` | 8 pass, 0 fail |

Cases observed:

1. The checker's published event types equal the monolith relay's `PUBLISHED_TYPES`.
2. Clean seeded state exits 0 in both `report` and `quiescent` mode. The SQLite file's SHA-256 and mtime are unchanged after the runs (read-only).
3. An unpublished event plus a pending cancellation work row: `report` exits 0 with `sqlite.outbox.unpublished` and `sqlite.financial.pending`, while `quiescent` exits 2.
4. An open `consistency_attention` row makes `quiescent` exit 2. Once `resolved_at` is set it exits 0.
5. Injected one at a time, each exits 1 with the named violation, and the state is clean again after undo:
   - `sqlite.holds.on_terminal_order`;
   - `sqlite.financial.cancel_ready_not_cancelled`;
   - `payments.ledger.payout_and_refund`;
   - `cross.paid_without_charge`;
   - `cross.cancel.refund_disagrees`.
6. A message in `payments.events.dlq` gives `attention:broker.dlq.payments.events.dlq`, and `quiescent` exits 2.
7. A missing SQLite file exits 3, never a pass.

Not run here: the checker against the real 16-service stack or a real rehearsal snapshot (A/D/E rehearsal step). Notifications checks are informational only (dedupe counts per consumer).

## A review follow-up — 10 November 2026

The lead authorized A to correct PR59 and merge only after validation. Original
C head `4fa301d` was reviewed; current main `434c327` (E58/61) was normally merged
into the same C branch without replacing teammate history. AI assisted the fixes.

Before the fix, isolated actual probes reproduced:

- one RabbitMQ delivery held without ack, passive ready count0, yet quiescent
  exit0 with no finding;
- a Payments database containing only migration001, yet quiescent exit0;
- matching order/kind/ready state but different financial command keys, with no
  cross-owner finding (pure exported checker probe).

Corrections keep the operator tool read-only: require core C tables and exact
Payments migration versions/checksums; compare command/operation IDs and immutable
request/ready result; add RabbitMQ management **GET** counters for unacknowledged
messages. AMQP alone records unknown coverage and cannot pass quiescence. Frozen
validation also requires disconnected consumers and blocks missing queues/DLQs.
No counter/permission/read failure is interpreted as an empty queue.

Observed current-source command:

```sh
bash scripts/run-consistency-check-tests.sh
```

Result: **11 tests passed,0 failed,0 skipped**, including the original cases and
real file-backed SQLite, PG16 and RabbitMQ4.1-management regressions for schema
absence, checksum drift, mismatching command/operation/request/result, unacked
consumer delivery, idle attached consumer, restored zero-work state, unavailable
management counters/API and a missing DLQ. The SQLite hash/mtime check remains.
The new dedicated CI job invokes this same isolated runner, using locked current
source dependencies, not the cached dependency image used for the initial review.

Initial fixture attempts caught a YAML tmpfs-quoting error and a test that read
management statistics before their first sample. Those fixture issues were fixed;
the passing full run started new stores, waited for asserted broker states and
cleaned its own containers/network. No production timeout or application behavior
was relaxed. No useful databases, Dify containers or production queues were used.

This is operator-checker acceptance, not a16-service cutover/rollback rehearsal.
Broker statistics are sampled; actual cutover still requires the separate reviewed
writer freeze/drain/checkpoint and all applicable owners. See the updated usage
handoff for environment-only credential handling and optional-source limits.
