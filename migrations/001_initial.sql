CREATE TABLE IF NOT EXISTS payment_transactions (
  id TEXT PRIMARY KEY,
  site_a_transaction_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  paystack_reference TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL,
  created_at TIMESTAMPTZ,
  data JSONB NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_transactions_site_a_txn_idx ON payment_transactions (site_a_transaction_id, purpose);
CREATE INDEX IF NOT EXISTS payment_transactions_status_idx ON payment_transactions (status);

CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  transaction_reference TEXT,
  event_type TEXT,
  received_at TIMESTAMPTZ,
  processed BOOLEAN NOT NULL DEFAULT FALSE,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS payment_webhook_reference_idx ON payment_webhook_events (transaction_reference);

CREATE TABLE IF NOT EXISTS payment_request_ids (request_id TEXT PRIMARY KEY, used_at TIMESTAMPTZ);

CREATE TABLE IF NOT EXISTS bundle_orders (
  reference TEXT PRIMARY KEY,
  paystack_reference TEXT NOT NULL UNIQUE,
  payment_status TEXT NOT NULL,
  status TEXT NOT NULL,
  fulfillment_status TEXT NOT NULL,
  created_at TIMESTAMPTZ,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS bundle_orders_payment_status_idx ON bundle_orders (payment_status);
CREATE INDEX IF NOT EXISTS bundle_orders_fulfillment_status_idx ON bundle_orders (fulfillment_status);

CREATE TABLE IF NOT EXISTS bundle_request_ids (request_id TEXT PRIMARY KEY, used_at TIMESTAMPTZ);
