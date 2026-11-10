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
