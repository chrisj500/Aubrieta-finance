# Aubrieta product requirements

## North-star requirement

Aubrieta should provide feature parity with the most useful parts of classic Mint for a private household while improving reliability, provider choice, and bill visibility.

## Required areas

### Overview
- household net worth
- cash and credit balances
- investments
- property and loan liabilities
- upcoming bills
- spending summary
- recent transactions
- connection health

### Transactions
- search and filtering
- automatic categorization
- editable categories
- merchant renaming
- rules
- split transactions
- transfer matching
- pending-to-posted reconciliation
- notes/tags
- manual transaction entry

### Bills
- authoritative credit-card due dates
- mortgage and supported loan due dates
- minimum payment and statement balance when available
- recurring utility/subscription detection
- manual recurring bills
- one-time bills
- automatic paid detection
- upcoming and overdue views
- bill calendar
- reminders and notifications
- expected-vs-actual amount tracking

### Budgets
- monthly/category budgets
- rollover support
- progress and overspend alerts
- household and personal scopes

### Trends
- spending by category
- income vs spending
- net worth
- account balances
- cash flow
- merchant/category trends
- selectable date ranges

### Goals
- account-linked savings goals
- debt payoff goals
- target dates and progress

### Investments
- holdings
- account market values
- performance history where data allows
- retirement and brokerage accounts

### Household
- private registration
- multiple household users
- joint/shared and personal accounts
- shared bills/budgets/goals
- configurable privacy for personal accounts

## Aggregation requirements

Aubrieta must support multiple providers concurrently. No provider-specific object may become the canonical account, transaction, bill, or investment record.

Initial target providers:

- Plaid
- Teller
- SimpleFIN
- OFX/QFX/CSV import

## Acceptance test for the first vertical slice

A household user can:

1. sign in
2. connect one real institution
3. sync accounts and transactions
4. connect a credit card with liability metadata
5. see its actual upcoming due date and statement/minimum amount
6. receive a configured reminder
7. keep all history after disconnecting or changing providers
