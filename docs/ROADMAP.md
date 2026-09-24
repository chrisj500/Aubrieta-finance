# Verbena roadmap

## M0 — Foundation
- import pinned Open Finance baseline
- preserve MIT attribution
- establish Verbena branding and architecture
- disable public deployment assumptions
- define provider-neutral contracts
- establish household-only registration model

## M1 — Provider-neutral core
- canonical Institution/Connection/Account mappings
- external-provider reference tables
- connection health and reauthentication states
- historical account identity independent of provider
- Plaid adapter migrated behind the Verbena contract
- Teller adapter
- SimpleFIN adapter
- OFX/QFX/CSV import adapter

## M2 — Mint-grade Bills
- liability ingestion
- credit-card statement balance/minimum/due date
- mortgage next payment/due date
- recurring transaction detector
- provider recurring-stream ingestion
- bill provenance/confidence model
- bill occurrences
- automatic paid matching
- upcoming/overdue calendar
- notification rules

## M3 — Household model
- public registration disabled
- household administrator
- invitations
- shared vs personal accounts
- account visibility
- household budgets/goals/bills/net worth

## M4 — Verbena experience
- Verbena design system
- Overview
- Transactions
- Bills
- Budgets
- Goals
- Trends
- Investments
- account detail
- connection health
- responsive PWA/mobile experience

## M5 — Hardening
- threat-model review
- encrypted backups
- migration/restore tests
- provider failover tests
- webhook signature validation
- rate limiting
- session/passkey/MFA review
- end-to-end production-provider smoke tests

## First vertical slice
Login → connect institution → sync transactions → ingest a real credit-card liability → show an authoritative due date → send a reminder.
