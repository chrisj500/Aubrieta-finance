# M5 Hardening Inventory & Threat Model

Status: active. M5 starts from the shipped M4 baseline; hardening should close demonstrated gaps without redesigning working product architecture.

## Assets and trust boundaries

Highest-value assets:
- household financial data and transaction history
- provider credentials/access tokens
- user passwords, recovery codes, sessions, agent tokens and pairing codes
- the instance encryption key and encrypted backup material
- instance-administrator capabilities
- the host update mechanism

Primary trust boundaries:
- browser/app session -> Aubrieta API
- agent Bearer token -> scoped agent API/MCP surface
- one household -> another household on the same instance
- Aubrieta -> aggregation providers/OAuth enrollment flows
- paired phone -> hub session
- encrypted backup file -> live SQLite database
- release/update source -> host-level update script

The persistent GitHub Actions runners are a separate infrastructure boundary. Runner network hardening remains intentionally deferred and must not block application M5 work; external-fork code stays off the self-hosted runners.

## Existing controls verified in the M5 inventory

### Authentication and sessions
- password hashes use the existing password service; login performs a dummy bcrypt verify for unknown users to reduce username timing disclosure
- raw session tokens are shown only to the client and SHA-256 hashed at rest
- sessions support absolute expiry plus a 90-day idle cap for `forever`
- last-seen writes and purge bookkeeping are memory-bounded
- secure cookies are the default; plain HTTP cookies require explicit development opt-in
- password changes revoke other sessions
- recovery codes are single-use

### CSRF and rate limiting
- cookie-authenticated mutations use `x-of-request: 1` CSRF enforcement
- login/register/recovery/password/pairing/bootstrap/demo and agent detection have route-level rate-limit coverage
- rate-limit maps are hard-capped against high-cardinality memory exhaustion
- current limiter is process-local by design and is acceptable only while Aubrieta remains a single-process/self-hosted deployment

### Data encryption and backups
- provider credentials and connection secrets use AES-256-GCM with record-bound AAD
- downloaded whole-instance `.ofbak` backups use AES-256-GCM authenticated encryption
- whole-instance backup/restore is restricted to instance administrators
- restore requires session + CSRF + password confirmation and caps upload size
- backup tampering/wrong-key input is rejected

### Provider enrollment and sync
- Teller enrollment uses a one-time nonce plus signature verification
- Akoya OAuth state is persisted, time-limited and single-use
- provider connection secrets are encrypted at rest
- provider sync validates tenant scope before writing
- optional liabilities/investments/recurring refreshes fail soft and keep the last known snapshot
- connection failures are recorded instead of silently presented as successful
- no provider currently advertises the `webhooks` capability and there is no inbound provider webhook route

### Multi-household and agents
- instance administration is separate from household membership
- users remain limited to one household
- provider connections carry explicit household tenant scope
- cross-household finance/agent isolation has regression coverage
- agent tokens are hashed at rest, revocable/expirable, scope-bound and intersected with current user access caps
- account allowlists constrain agent data access
- host/admin/auth/backup/household surfaces are not agent APIs

### Device lock and pairing
- pairing codes are random, hashed at rest, single-use, TTL-bound, rate-limited and atomically claimed
- device PINs use salted PBKDF2-SHA256 with timing-safe verification
- repeated PIN failures cause exponential lockout
- PIN/biometric configuration cannot be changed to bypass an active lockout

### Browser/server response hardening
- CSP, frame denial, MIME sniffing protection, referrer policy, permissions policy and HSTS are configured
- API responses are `Cache-Control: no-store`

## M5 gap sequence

### M5.1 — Instance update authorization — critical

Finding: update state is hub-wide and `action: now` executes a fixed host script, but `/api/updates` and `/api/updates/decide` previously required only an ordinary user session. Any household user on a multi-household instance could therefore check/mutate global update state and trigger host-level update execution.

Required closure:
- all server-side update mutations require instance-administrator authorization
- status explicitly reports whether the signed-in user may manage instance updates
- non-admin users do not receive host update action UI
- standalone/solo keeps its local update behavior
- update endpoints remain explicitly classified as user-only/non-agent surfaces

### M5.2 — Restore staging, integrity and encrypted safety backup — high — complete

Closed:
- restore decrypts into a unique same-directory staging database rather than overwriting the live path
- staging runs `PRAGMA quick_check` before migration and again after migration
- staged restore must reach the repository's current migration/schema version before activation
- the durable pre-restore safety artifact is an encrypted `.ofbak`, not a plaintext `.db`
- the live database is closed/safely checkpointed only after staging proves valid
- activation uses a same-directory rollback file and restores the original database if activation/reopen validation fails
- staging and temporary rollback plaintext artifacts are removed after success/failure
- regression coverage proves current restore, encrypted safety backup contents, old-schema migration, corrupt staged DB rejection and preservation of the original live DB

### M5.3 — Update supply-chain source — high — complete

Closed:
- hub and standalone update discovery now share one canonical Aubrieta release source: `chrisj500/Aubrieta-finance`
- the update status reports the explicit source label `github:chrisj500/Aubrieta-finance` (or `custom-url` for an operator override)
- the native release flow discovers `app-release.apk` plus `SHA256SUMS` from the canonical release
- native automatic install fails closed unless a valid 64-hex SHA-256 is available
- the Android updater independently rejects missing/malformed checksums before network download and always verifies the downloaded APK before opening the installer
- redirect hops remain HTTPS-only and restricted to the existing trusted GitHub release host allowlist
- the one-line installer now downloads Aubrieta from `chrisj500/Aubrieta-finance` rather than the historical upstream repository
- the hub still executes only the fixed operator-controlled `UPDATE_SCRIPT`; release metadata cannot select commands or scripts

### M5.4 — Provider failure isolation regression — medium/high — complete

Closed:
- the aggregate sync route isolates unexpected provider-wide failures so one provider cannot reject the entire multi-provider refresh
- provider-specific result shapes are preserved, including Plaid's existing `itemId` contract
- a provider-wide failure returns a generic synthetic failed result rather than leaking the underlying exception
- optional capability failures preserve prior liabilities/holdings/recurring snapshots
- a failed connection records error state without corrupting another successful connection
- existing multi-household regression coverage proves provider tenant mismatch fails closed before provider data is fetched/written

### M5.5 — Webhook authenticity gate — deferred until webhooks exist

There is currently no inbound provider webhook endpoint. `WEBHOOK_SECRET` is defined but unused. Before the first webhook receiver ships:
- provider-specific signature/JWT verification must be implemented
- replay/timestamp protections must be tested where the provider supports them
- raw webhook bodies must not be processed before authenticity is established
- only then may a provider advertise the `webhooks` capability

### M5.6 — Session / passkey / MFA review — medium — complete

Decision and closure for the current deployment model:
- Aubrieta's supported hub model is private household self-hosting over LAN, Tailscale, or HTTPS rather than a public multi-tenant SaaS login surface
- the existing password/session path remains the required hub authentication baseline: bcrypt password verification, timing-safe nonexistent-user handling, hashed session tokens, secure-cookie default, absolute/idle expiry, session listing/revocation, rate limits, CSRF, and single-use recovery codes
- logout and logout-all now enforce the same CSRF header as other cookie-authenticated mutations; logout-all cannot be cross-site-triggered to revoke every session
- passkeys/WebAuthn and TOTP MFA are not required for M5 completion under this threat model; adding either would introduce credential/challenge schema, recovery, disable/reset, and session-transition semantics that should not be bolted on without a deployment need
- revisit MFA if Aubrieta is intentionally exposed directly to the public Internet, operated for unrelated/high-risk users, or otherwise moves beyond the current LAN/Tailscale/HTTPS household model
- if MFA is added later, define recovery and session revocation first; TOTP secrets must be encrypted at rest and replay/rate-limit behavior tested, while WebAuthn must account for stable RP ID/origin requirements across self-hosted hostnames
- do not weaken or replace the current password/recovery path merely to add a second authentication mechanism

### M5.7 — Production-provider smoke tests — final M5 gate — harness complete; live run pending

Implemented:
- `npm run smoke:providers` is an explicit operator-only harness against a running Aubrieta instance
- it requires `AUBRIETA_PROVIDER_SMOKE=YES_I_UNDERSTAND` plus an explicit provider list and authenticated session/login
- remote plain HTTP is rejected; provider sandbox connections require a second explicit opt-in
- the harness reuses the product's real aggregate sync, connection-health, provider connection-list and account-detail APIs; no provider credentials are passed to or printed by the runner
- it performs two sync passes, verifies linked accounts and healthy timestamps, and checks provider liability detail when a liability-capable provider has a linked credit/loan account
- it prints only provider names/counts and generic failures, never balances, transactions, account/institution names, tokens or secrets
- interactive provider enrollment/re-auth remains a human UI prerequisite/path; a re-auth-required connection fails smoke through sync/health and is repaired through the normal provider UI
- ordinary CI must not invoke the live smoke and the self-hosted runners must not receive production provider secrets

### M5.8 — Session mutation CSRF completeness — medium — complete

Closed:
- `PUT /api/agent/manual` now enforces the same `x-of-request` CSRF marker as other cookie-authenticated mutations
- the agent manual remains readable through either the signed-in human session or the existing Bearer-token polling contract; only the human edit path is mutable
- the mixed-auth route is explicitly documented as user-only for PUT in the route registry
- regression coverage proves a cross-site-style cookie mutation is rejected without changing the manual and a legitimate CSRF-marked edit still succeeds
- a source-level guard now fails tests if any API route combines `requireSession` with POST/PATCH/PUT/DELETE but omits `requireCsrf`

Final M5 gate:
- perform and record at least one successful live-provider run using `docs/PROVIDER_SMOKE.md`; until then the hardening code is complete but M5 is not declared operationally complete

## Accepted/deferred risks

- Process-local rate limiting resets on restart and would not coordinate across multiple app processes. Revisit only if Aubrieta becomes horizontally scaled.
- CSP still requires inline allowances for the current Next/UI build. Tightening this is desirable but should be handled as a tested compatibility slice, not a blind header change.
- Self-hosted CI runner network segmentation is intentionally deferred by the operator; same-repo-only runner routing remains mandatory until then.
- Household-level export/restore remains a later feature; whole-instance backup stays instance-admin-only.
