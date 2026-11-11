-- Offline-approved manifest bindings only. Does not adopt historical provisioning
-- or enable legacy settlement. See docs/legacy-manifest-contract-handoff.md.
-- Match the entire owned intent identity, not just its numeric ID.
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_binding_context
  UNIQUE (id, order_id, customer_id, provider_id, amount_cents, currency);
CREATE TABLE legacy_payment_bindings (
  order_id INTEGER PRIMARY KEY CHECK (order_id BETWEEN 1 AND 2147483646),
  binding_id TEXT NOT NULL UNIQUE,
  manifest_sha256 TEXT NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$' AND length(manifest_sha256) = 64),
  intent_id INTEGER NOT NULL UNIQUE CHECK (intent_id BETWEEN 1 AND 2147483646),
  customer_id INTEGER NOT NULL CHECK (customer_id BETWEEN 1 AND 2147483646),
  provider_id INTEGER NOT NULL CHECK (provider_id BETWEEN 1 AND 2147483646),
  amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN 0 AND 2147483646),
  currency TEXT NOT NULL CHECK (currency = 'THB'),
  eligibility TEXT NOT NULL CHECK (eligibility IN ('open_unpaid','open_paid')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (binding_id = 'legacy:' || manifest_sha256 || ':' || order_id::text),
  FOREIGN KEY (intent_id, order_id, customer_id, provider_id, amount_cents, currency)
    REFERENCES payment_intents (id, order_id, customer_id, provider_id, amount_cents, currency)
);
