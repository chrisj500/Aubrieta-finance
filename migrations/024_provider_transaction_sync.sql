-- 024: provider-neutral transaction identity and runtime connection state.
-- This moves sync ownership out of Plaid-specific tables and creates the
-- credential/nonce primitives needed for additional aggregation providers.

ALTER TABLE provider_connections ADD COLUMN environment TEXT;
ALTER TABLE provider_connections ADD COLUMN sync_cursor TEXT;
ALTER TABLE provider_connections ADD COLUMN last_sync_at TEXT;
ALTER TABLE provider_connections ADD COLUMN last_error TEXT;

CREATE TABLE provider_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  environment TEXT NOT NULL,
  config_enc TEXT NOT NULL,
  public_config_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, provider, environment)
);
CREATE INDEX idx_provider_credentials_user
  ON provider_credentials(user_id, provider, environment);

CREATE TABLE provider_connection_secrets (
  connection_id TEXT PRIMARY KEY REFERENCES provider_connections(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret_enc TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_provider_connection_secrets_user
  ON provider_connection_secrets(user_id);

CREATE TABLE provider_connect_nonces (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  environment TEXT NOT NULL,
  nonce TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_provider_connect_nonces_lookup
  ON provider_connect_nonces(user_id, provider, environment, nonce, used_at);

CREATE TABLE transaction_provider_refs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_transaction_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, external_transaction_id),
  UNIQUE (transaction_id, provider)
);
CREATE INDEX idx_transaction_provider_refs_connection
  ON transaction_provider_refs(connection_id, provider);
CREATE INDEX idx_transaction_provider_refs_account
  ON transaction_provider_refs(account_id, provider);

-- Backfill the generic connection cursor/state from legacy Plaid Items.
UPDATE provider_connections
   SET environment = (
         SELECT p.environment FROM plaid_items p
          WHERE p.id = provider_connections.legacy_plaid_item_id
       ),
       sync_cursor = (
         SELECT p.cursor FROM plaid_items p
          WHERE p.id = provider_connections.legacy_plaid_item_id
       ),
       last_sync_at = (
         SELECT p.last_sync_at FROM plaid_items p
          WHERE p.id = provider_connections.legacy_plaid_item_id
       )
 WHERE provider = 'plaid'
   AND legacy_plaid_item_id IS NOT NULL;

-- Backfill provider-neutral transaction references for existing Plaid rows.
INSERT INTO transaction_provider_refs (
  id, user_id, transaction_id, account_id, connection_id, provider,
  external_transaction_id, created_at, updated_at
)
SELECT
  'plaid:' || t.id,
  a.user_id,
  t.id,
  t.account_id,
  r.connection_id,
  'plaid',
  t.plaid_transaction_id,
  t.created_at,
  t.created_at
FROM transactions t
JOIN accounts a ON a.id = t.account_id
JOIN account_provider_refs r
  ON r.account_id = t.account_id AND r.provider = 'plaid'
WHERE t.plaid_transaction_id IS NOT NULL
ON CONFLICT(provider, external_transaction_id) DO NOTHING;
