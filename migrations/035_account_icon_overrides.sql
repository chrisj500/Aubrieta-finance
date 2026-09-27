-- 035: Per-user custom artwork for individual accounts.
-- Account artwork is stored separately from inferred card identity so users
-- can use an exact card image without changing provider/product metadata.
CREATE TABLE account_icon_overrides (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data_url TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, user_id)
);
CREATE INDEX idx_account_icon_overrides_user
  ON account_icon_overrides(user_id);
