-- 027: Multi-household hosting foundation.
-- Keeps the one-user/one-household invariant while adding instance-level
-- administration, owner-provisioning invitations, and explicit tenant scope
-- for provider connections/background sync.

CREATE TABLE instance_admins (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);

-- Existing installs get one deterministic instance admin: the oldest real user.
INSERT INTO instance_admins (user_id, created_at, created_by_user_id)
SELECT id, created_at, id
FROM users
WHERE is_demo = 0 AND username IS NOT NULL
ORDER BY created_at, id
LIMIT 1;

-- M3 invitations only permitted role='member'. Rebuild the table so an
-- instance administrator can provision an empty household and invite its first
-- owner without becoming a household member or gaining finance access.
DROP INDEX IF EXISTS idx_household_invitations_household;
ALTER TABLE household_invitations RENAME TO household_invitations_m3;

CREATE TABLE household_invitations (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  invitee_email TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  invited_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  accepted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

INSERT INTO household_invitations (
  id, household_id, token_hash, invitee_email, role, invited_by_user_id,
  expires_at, accepted_by_user_id, accepted_at, revoked_at, created_at
)
SELECT
  id, household_id, token_hash, invitee_email, role, invited_by_user_id,
  expires_at, accepted_by_user_id, accepted_at, revoked_at, created_at
FROM household_invitations_m3;

DROP TABLE household_invitations_m3;

CREATE INDEX idx_household_invitations_household
  ON household_invitations(household_id, accepted_at, revoked_at);

-- Provider connections are still owned by an individual user, but tenant scope
-- is now explicit so background jobs can select/validate by household too.
ALTER TABLE provider_connections ADD COLUMN household_id TEXT REFERENCES households(id) ON DELETE CASCADE;
UPDATE provider_connections
   SET household_id = (
     SELECT hm.household_id
       FROM household_members hm
      WHERE hm.user_id = provider_connections.user_id
   );
CREATE INDEX idx_provider_connections_household
  ON provider_connections(household_id, provider, status);
