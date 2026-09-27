-- 034: Per-user custom institution/group icons.
-- Stored as small normalized data URLs so icons travel with DB backups and
-- remain portable to solo SQLite / a future PostgreSQL adapter.
CREATE TABLE institution_icon_overrides (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  institution_key TEXT NOT NULL,
  institution_name TEXT NOT NULL,
  data_url TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, institution_key)
);
CREATE INDEX idx_institution_icon_overrides_user
  ON institution_icon_overrides(user_id);
