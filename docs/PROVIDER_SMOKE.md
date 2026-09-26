# Production provider smoke test

M5.7 is an operator-run, opt-in smoke procedure for **real configured provider connections**. It deliberately does not run in ordinary CI and does not put production provider secrets on GitHub Actions runners.

## What it exercises

The runner uses Aubrieta's existing authenticated HTTP API and the same aggregate sync route used by the product. It does not implement a second provider client.

For each explicitly selected provider it verifies:

1. A connection was already established through Aubrieta's normal provider enrollment UI.
2. First live sync succeeds through `/api/transactions/sync`.
3. Connection Health becomes/remains healthy, has a successful-sync timestamp, and has linked accounts.
4. Provider-specific connection listing can resolve the linked Aubrieta account ids.
5. Account Detail can read each linked account; when the provider advertises `liabilities` and a linked credit/loan account exists, at least one provider liability record must be present.
6. A second live sync succeeds, exercising the resync path.
7. Connection Health remains healthy after resync.

Interactive OAuth/enrollment and re-auth UI are intentionally not automated. Those third-party flows require human interaction and provider-hosted UI. The procedure's **connect** step is therefore a prerequisite performed through the normal Aubrieta UI; the automated runner covers sync -> data -> health -> resync. A connection that needs re-auth fails the smoke through its sync/health state and should then be repaired with the normal provider management UI.

The runner prints only provider names and counts. It does **not** print account names, balances, transaction data, institution names, tokens, passwords, or provider secrets.

## Safety gates

The runner refuses to start unless all of the following are true:

- `AUBRIETA_PROVIDER_SMOKE=YES_I_UNDERSTAND`
- `AUBRIETA_SMOKE_BASE_URL` is explicit
- `AUBRIETA_SMOKE_PROVIDERS` explicitly lists one or more of `plaid,teller,simplefin,akoya`
- authentication is supplied either by an existing session cookie or username/password
- remote URLs use HTTPS; plain HTTP is allowed only for localhost/loopback
- sandbox connections are rejected unless `AUBRIETA_SMOKE_ALLOW_SANDBOX=1` is explicitly set

The smoke performs ordinary sync writes to the Aubrieta database (the same writes as pressing **Refresh all**). It does not initiate payments, transfers, provider revocation, account deletion, or credential changes.

## Run against a real instance

First connect the provider through Aubrieta and confirm the normal UI shows the connection.

From the Aubrieta source checkout, use either an existing session cookie or a short-lived login. A short-lived login is usually simpler:

```sh
export AUBRIETA_PROVIDER_SMOKE=YES_I_UNDERSTAND
export AUBRIETA_SMOKE_BASE_URL=https://your-aubrieta-host.example
export AUBRIETA_SMOKE_PROVIDERS=plaid
export AUBRIETA_SMOKE_USERNAME='your-user'
read -s AUBRIETA_SMOKE_PASSWORD && export AUBRIETA_SMOKE_PASSWORD
npm run smoke:providers
unset AUBRIETA_SMOKE_PASSWORD
```

For more than one configured provider:

```sh
export AUBRIETA_SMOKE_PROVIDERS=plaid,teller,simplefin,akoya
```

For an intentional provider sandbox run only:

```sh
export AUBRIETA_SMOKE_ALLOW_SANDBOX=1
```

A passing run ends with:

```text
Sync pass 2 / resync: PASS
Connection health: PASS
M5.7 provider smoke: PASS
```

## CI rule

Do not add this command to normal GitHub Actions jobs. The persistent self-hosted runners must remain free of production provider credentials. Unit/integration tests may mock the Aubrieta HTTP surface to validate the smoke harness itself.
