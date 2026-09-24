# Security Policy

Aubrieta handles highly sensitive financial data. Security reports should not be posted in public issues when they contain exploit details, credentials, tokens, account identifiers, or private financial data.

## Reporting a vulnerability

For now, please use GitHub's private vulnerability reporting feature if enabled for this repository. If private vulnerability reporting is unavailable, open a minimal public issue requesting a private contact channel without including exploit details.

## Scope

Security-sensitive areas include:

- authentication and session handling
- provider access-token storage
- webhook validation
- authorization and household isolation
- database encryption and backups
- financial-data import and parsing
- secret handling
- dependency and supply-chain integrity

## Secrets

Never commit:

- Plaid secrets or access tokens
- Teller certificates or private keys
- SimpleFIN access URLs
- email/SMTP credentials
- push-notification credentials
- production database files
- backups
- real household financial exports

Use environment variables or an external secret store for runtime secrets.
