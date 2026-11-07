-- Area C: consumer-side dedupe (idempotent receiver, Week 9 slides 26–30).
-- A row is inserted in the SAME transaction as the consumer's effect, so an
-- event either has both its dedupe record and its notifications, or neither.
-- The key is scoped per consumer: one consumer processing an event must never
-- suppress a different consumer of the same event.
CREATE TABLE processed_events (
  consumer_name TEXT NOT NULL,
  event_id      UUID NOT NULL,
  event_type    TEXT NOT NULL,
  producer      TEXT NOT NULL,
  effect_count  INTEGER NOT NULL CHECK (effect_count >= 0),
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_name, event_id)
);
