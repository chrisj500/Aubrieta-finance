-- 028: Persist provider investment securities and holdings.
-- Holdings are point-in-time snapshots refreshed during provider sync.

CREATE TABLE investment_securities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_security_id TEXT NOT NULL,
  name TEXT NOT NULL,
  ticker TEXT,
  isin TEXT,
  cusip TEXT,
  security_type TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  updated_at TEXT NOT NULL,
  UNIQUE (connection_id, provider, external_security_id)
);

CREATE INDEX idx_investment_securities_user
  ON investment_securities(user_id, provider, ticker);

CREATE TABLE investment_holdings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  security_id TEXT NOT NULL REFERENCES investment_securities(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  quantity REAL NOT NULL,
  institution_price_cents INTEGER,
  institution_value_cents INTEGER,
  cost_basis_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'USD',
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, security_id)
);

CREATE INDEX idx_investment_holdings_user
  ON investment_holdings(user_id, account_id);
