# Verbena architecture

## Product boundary

Verbena owns the canonical household-finance model. Aggregation vendors are adapters, not the source of truth.

The application must never require Plaid-specific identifiers outside the provider-integration layer.

## Canonical entities

- Household
- User
- Institution
- Connection
- Account
- BalanceSnapshot
- Transaction
- Holding
- Security
- Liability
- Statement
- RecurringSeries
- Bill
- BillOccurrence
- Budget
- Goal
- NotificationPreference
- NotificationEvent

All durable records use Verbena-owned IDs. Provider IDs are stored as external references.

## Provider layer

Every financial-data provider implements a common contract and declares capabilities.

Initial providers:

- Plaid
- Teller
- SimpleFIN
- File import (OFX/QFX/CSV)

Future providers can be added without changing the domain model.

A provider may support some or all of:

- accounts
- balances
- transactions
- liabilities
- investments
- statements
- recurring streams
- webhooks
- refresh
- reauthentication

Provider capability detection must drive the UI and sync jobs.

## Provider selection

A household may use different providers for different institutions.

An account can change providers without losing its Verbena account identity or history.

Where duplicate provider connections exist, Verbena must reconcile rather than duplicate accounts.

## Bills engine

Bill facts are merged using this priority:

1. Authoritative liability/statement data from the provider.
2. Provider-supplied recurring stream data.
3. Verbena recurring-transaction detection.
4. User-entered or user-overridden schedule.

Each bill occurrence records provenance and confidence.

Examples:

- credit card due date from Liabilities: authoritative
- mortgage next payment from Liabilities: authoritative
- electric utility inferred from transaction history: predicted
- HOA entered manually: user-defined

## Notifications

Notifications are generated from BillOccurrence and account-health events, not directly from provider webhooks.

Supported reminder rules should include:

- configurable days before due date
- due tomorrow
- due today
- overdue
- statement available
- expected bill amount changed materially
- new recurring charge detected
- account connection needs attention

Channels can include:

- in-app
- browser/PWA push
- mobile local/push
- email

## Household model

Verbena is not a public SaaS product.

- Public registration is disabled.
- The first user becomes household administrator.
- Additional users are invited by an administrator.
- Accounts may be personal or shared.
- Shared budgets, goals, bills, and net worth are household-scoped.
- Personal-account visibility can be restricted.

## Security principles

- Provider access tokens encrypted at rest.
- No financial credentials in client-side code.
- Session cookies are HttpOnly, Secure in production, and SameSite.
- CSRF protection for state-changing browser requests.
- Secrets come from environment variables or a secret store.
- No public GitHub Pages deployment.
- Audit sensitive connection and account-management operations.
- Favor a private network/VPN deployment for remote access.

## Upstream strategy

Open Finance is a source foundation, not a permanent architectural constraint.

Upstream changes are reviewed and selectively incorporated. We do not automatically merge upstream main into Verbena.

The canonical upstream provenance is documented in UPSTREAM.md.
