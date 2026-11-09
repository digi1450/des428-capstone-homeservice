-- Area C: durable financial finalization (step 5C, contract v1.0.0;
-- docs/financial-finalization-decisions.md and -contract-handoff.md).
-- Separate from payment_commands on purpose: provisioning (create/cancel/activate) and financial
-- (completion/cancellation) keys and results are different protocols and must never alias.

-- One row per accepted financial command. The stored result is replayed verbatim for the same
-- caller/key/request; a 'pending' row may progress to 'ready'/'attention' under the same key.
-- At most one completion and one cancellation per order (a different key for the same order is a
-- conflict, never a second payout/refund).
CREATE TABLE financial_commands (
  caller_id      TEXT NOT NULL,
  command_id     TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('completion','cancellation')),
  operation_id   UUID NOT NULL,
  order_id       INTEGER NOT NULL CHECK (order_id > 0),
  request_digest TEXT NOT NULL,
  request        JSONB NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('pending','ready','attention')),
  result         JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (caller_id, command_id),
  UNIQUE (kind, order_id),
  CHECK (command_id = (CASE kind WHEN 'completion' THEN 'complete:' ELSE 'cancel:' END) || operation_id::text)
);

-- Order-level settlement fence written atomically with a READY cancellation. While it exists no
-- webhook can settle, no provisioning create/activate can succeed and no completion can credit.
CREATE TABLE financial_fences (
  order_id   INTEGER PRIMARY KEY CHECK (order_id > 0),
  caller_id  TEXT NOT NULL,
  command_id TEXT NOT NULL,
  outcome    TEXT NOT NULL CHECK (outcome IN ('no_payment','voided','refunded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (caller_id, command_id) REFERENCES financial_commands (caller_id, command_id)
);
