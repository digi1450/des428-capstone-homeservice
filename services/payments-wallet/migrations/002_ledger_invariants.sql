ALTER TABLE transactions ADD COLUMN context_json JSONB NOT NULL DEFAULT '{}'::jsonb;
-- Business effect uniqueness is per booking/kind, independent of C's message IDs.
-- Audit any historical duplicates before importing legacy rows into this schema.
CREATE UNIQUE INDEX idx_transactions_order_kind ON transactions(order_id, kind) WHERE order_id IS NOT NULL;
