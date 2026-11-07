-- Area C: Payments participant for the Booking-orchestrated saga
-- (docs/c-payment-participant-interface.md, agreed in PRs #24/#25).

-- One row per command key; the stored result is replayed verbatim for the exact same request.
-- The key spans kinds: reusing a command id for another kind/target/request is a conflict.
CREATE TABLE payment_commands (
  caller_id         TEXT NOT NULL,
  command_id        TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('create','cancel','activate')),
  create_command_id TEXT NOT NULL,
  request_digest    TEXT NOT NULL,
  result            JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (caller_id, command_id)
);

-- Authoritative fence / eligibility for one provisioning (caller + create command).
--   created   intent exists, NOT settleable
--   activated Booking confirmed provisioning; settleable (assertSettlementAllowed)
--   fenced    cancelled; a create can never commit afterwards (may have no intent at all)
CREATE TABLE payment_provisioning (
  caller_id           TEXT NOT NULL,
  create_command_id   TEXT NOT NULL,
  saga_id             TEXT NOT NULL,
  state               TEXT NOT NULL CHECK (state IN ('created','fenced','activated')),
  order_id            INTEGER UNIQUE,
  customer_id         INTEGER,
  provider_id         INTEGER,
  amount_cents        INTEGER,
  currency            TEXT,
  intent_id           INTEGER UNIQUE, -- no FK: importer truncates payment_intents; written in the same tx
  cancel_command_id   TEXT,
  cancel_reason       TEXT,
  activate_command_id TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (caller_id, create_command_id),
  CHECK (state = 'fenced' OR (order_id IS NOT NULL AND intent_id IS NOT NULL)),
  CHECK (state <> 'fenced' OR cancel_command_id IS NOT NULL),
  CHECK (state <> 'activated' OR activate_command_id IS NOT NULL)
);

-- Consumer dedupe for the wallet-provisioning consumer (provider.registered), same pattern as
-- Notifications: inserted in the same transaction as the effect, scoped per consumer.
CREATE TABLE processed_events (
  consumer_name TEXT NOT NULL,
  event_id      UUID NOT NULL,
  event_type    TEXT NOT NULL,
  producer      TEXT NOT NULL,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_name, event_id)
);
