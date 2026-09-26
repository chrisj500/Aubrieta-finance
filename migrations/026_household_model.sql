-- 026: Household model.
-- Adds invitation-only household membership plus explicit ownership/visibility
-- on financial objects. Existing single-user data is migrated into one
-- household per user and remains shared inside that household.

CREATE TABLE households (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE household_members (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (household_id, user_id),
  UNIQUE (user_id)
);

CREATE INDEX idx_household_members_household
  ON household_members(household_id, role);
CREATE TABLE household_invitations (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  invitee_email TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member')),
  invited_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  accepted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_household_invitations_household
  ON household_invitations(household_id, accepted_at, revoked_at);

INSERT INTO households (id, name, created_by_user_id, created_at, updated_at)
SELECT
  'household:' || id,
  COALESCE(NULLIF(trim(display_name), ''), COALESCE(username, 'Household')) || '''s Household',
  id,
  created_at,
  updated_at
FROM users;
INSERT INTO household_members (household_id, user_id, role, joined_at)
SELECT 'household:' || id, id, 'owner', created_at
FROM users;

ALTER TABLE accounts ADD COLUMN household_id TEXT REFERENCES households(id) ON DELETE CASCADE;
ALTER TABLE accounts ADD COLUMN owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared'
  CHECK (visibility IN ('shared','private'));

UPDATE accounts
   SET household_id = 'household:' || user_id,
       owner_user_id = user_id;

CREATE INDEX idx_accounts_household_visibility
  ON accounts(household_id, visibility, deleted_at);
CREATE INDEX idx_accounts_owner
  ON accounts(owner_user_id, deleted_at);

ALTER TABLE budgets ADD COLUMN household_id TEXT REFERENCES households(id) ON DELETE CASCADE;
ALTER TABLE budgets ADD COLUMN owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE budgets ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared'
  CHECK (visibility IN ('shared','private'));
UPDATE budgets
   SET household_id = 'household:' || user_id,
       owner_user_id = user_id;
CREATE INDEX idx_budgets_household_visibility
  ON budgets(household_id, visibility);

ALTER TABLE bills ADD COLUMN household_id TEXT REFERENCES households(id) ON DELETE CASCADE;
ALTER TABLE bills ADD COLUMN owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE bills ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared'
  CHECK (visibility IN ('shared','private'));
UPDATE bills
   SET household_id = 'household:' || user_id,
       owner_user_id = user_id;
CREATE INDEX idx_bills_household_visibility
  ON bills(household_id, visibility, active, next_due_date);

ALTER TABLE goals ADD COLUMN household_id TEXT REFERENCES households(id) ON DELETE CASCADE;
ALTER TABLE goals ADD COLUMN owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE goals ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared'
  CHECK (visibility IN ('shared','private'));
UPDATE goals
   SET household_id = 'household:' || user_id,
       owner_user_id = user_id;
CREATE INDEX idx_goals_household_visibility
  ON goals(household_id, visibility);
ALTER TABLE debts ADD COLUMN household_id TEXT REFERENCES households(id) ON DELETE CASCADE;
ALTER TABLE debts ADD COLUMN owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE debts ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared'
  CHECK (visibility IN ('shared','private'));
UPDATE debts
   SET household_id = 'household:' || user_id,
       owner_user_id = user_id;
CREATE INDEX idx_debts_household_visibility
  ON debts(household_id, visibility);
