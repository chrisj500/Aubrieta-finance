-- 023: provider-neutral connection/account identity + normalized liabilities.
-- Aubrieta owns canonical records; provider-specific ids are external references.

CREATE TABLE provider_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_connection_id TEXT,
  institution_external_id TEXT,
  institution_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  legacy_plaid_item_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, provider, external_connection_id)
);
CREATE INDEX idx_provider_connections_user ON provider_connections(user_id, provider);

CREATE TABLE account_provider_refs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, external_account_id),
  UNIQUE (account_id, provider)
);
CREATE INDEX idx_account_provider_refs_connection ON account_provider_refs(connection_id);
CREATE INDEX idx_account_provider_refs_user ON account_provider_refs(user_id, provider);

CREATE TABLE liabilities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_external_account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  next_payment_due_date TEXT,
  minimum_payment_cents INTEGER,
  statement_balance_cents INTEGER,
  statement_date TEXT,
  next_monthly_payment_cents INTEGER,
  apr_bps INTEGER,
  last_payment_amount_cents INTEGER,
  last_payment_date TEXT,
  raw_status TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  synced_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, provider_external_account_id)
);
CREATE INDEX idx_liabilities_user_due ON liabilities(user_id, next_payment_due_date);
CREATE INDEX idx_liabilities_connection ON liabilities(connection_id, active);

ALTER TABLE bills ADD COLUMN provider_liability_id TEXT REFERENCES liabilities(id) ON DELETE SET NULL;
ALTER TABLE bills ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE bills ADD COLUMN source_confidence TEXT NOT NULL DEFAULT 'user';
CREATE UNIQUE INDEX idx_bills_provider_liability
  ON bills(provider_liability_id)
  WHERE provider_liability_id IS NOT NULL;

-- Backfill current Plaid items into the provider-neutral identity layer.
INSERT INTO provider_connections (
  id, user_id, provider, external_connection_id, institution_external_id,
  institution_name, status, capabilities_json, legacy_plaid_item_id,
  created_at, updated_at
)
SELECT
  'plaid:' || p.id,
  p.user_id,
  'plaid',
  p.plaid_item_id,
  p.institution_id,
  p.institution_name,
  p.status,
  '["accounts","balances","transactions","liabilities","refresh","reauth"]',
  p.id,
  p.created_at,
  COALESCE(p.last_sync_at, p.created_at)
FROM plaid_items p;

INSERT INTO account_provider_refs (
  id, user_id, account_id, connection_id, provider, external_account_id,
  created_at, updated_at
)
SELECT
  'plaid:' || a.id,
  a.user_id,
  a.id,
  'plaid:' || a.item_id,
  'plaid',
  a.plaid_account_id,
  a.created_at,
  a.created_at
FROM accounts a
WHERE a.item_id IS NOT NULL
  AND a.plaid_account_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM provider_connections pc WHERE pc.id = 'plaid:' || a.item_id);
