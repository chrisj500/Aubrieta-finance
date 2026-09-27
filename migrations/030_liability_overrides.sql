-- 030: Optional user-entered liability metadata that can coexist with provider data.
-- Due day is recurring so users set it once; Aubrieta derives the next date.
CREATE TABLE account_liability_overrides (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  due_day INTEGER CHECK (due_day IS NULL OR (due_day >= 1 AND due_day <= 31)),
  apr_bps INTEGER CHECK (apr_bps IS NULL OR (apr_bps >= 0 AND apr_bps <= 100000)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_account_liability_overrides_user ON account_liability_overrides(user_id);
