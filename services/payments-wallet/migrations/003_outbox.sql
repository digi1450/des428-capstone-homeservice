-- Area C: transactional outbox for events produced by Payments & Wallet.
-- Rows are inserted with the SAME client/transaction as the business change
-- (see src/messaging/outbox.js). A separate relay publishes them to RabbitMQ.
-- Delivery is at-least-once: a row may be published more than once, always with
-- the same event_id, so every consumer must deduplicate by event_id.
CREATE TABLE outbox_events (
  seq            BIGSERIAL UNIQUE,
  event_id       UUID PRIMARY KEY,
  event_type     TEXT NOT NULL CHECK (event_type ~ '^[a-z]+(\.[a-z_]+)+$'),
  aggregate_type TEXT NOT NULL,
  aggregate_id   TEXT NOT NULL,
  envelope       JSONB NOT NULL,          -- immutable message body, published verbatim
  headers        JSONB NOT NULL DEFAULT '{}'::jsonb, -- trace context only, never credentials
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at   TIMESTAMPTZ,
  attempts       INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by      TEXT,
  locked_until   TIMESTAMPTZ,
  last_error     TEXT,
  CHECK ((envelope->>'event_id')::uuid = event_id),
  CHECK (envelope->>'event_type' = event_type)
);

-- The relay only scans unpublished rows.
CREATE INDEX outbox_events_pending ON outbox_events (next_attempt_at, seq) WHERE published_at IS NULL;
