# Contributing to Aubrieta

Thanks for considering a contribution.

Aubrieta is an open-source, self-hosted personal-finance project derived from Open Finance and focused on provider choice, recurring bills, liabilities, investments, and household use.

## Development principles

- Keep provider SDK types inside provider adapters.
- Do not make Plaid, Teller, SimpleFIN, or any other provider the canonical data model.
- Use synthetic data in tests, fixtures, and screenshots.
- Preserve account history when connections are replaced or providers change.
- Treat Bills and notification correctness as first-class behavior.
- Avoid introducing public-SaaS assumptions into core flows.
- Add or update tests for behavior changes.

## Pull requests

Please keep changes focused and describe:

- what changed
- why it changed
- migrations or compatibility impact
- security/privacy implications
- tests performed

## Financial data

Never include real bank data, account numbers, transaction exports, provider tokens, or household identifiers in issues, tests, screenshots, or pull requests.
