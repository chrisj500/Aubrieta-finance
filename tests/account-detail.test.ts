import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAccountDetailService } from "@/server/domain/account-detail";
import { createTestDb, seedManualAccount, seedUser } from "./helpers";

describe("account detail", () => {
  it("returns account summary, history, recent activity, and month flow", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "account-detail");
    const accountId = await seedManualAccount(db, user.id, "Checking", "depository");
    const now = new Date().toISOString();
    const month = now.slice(0, 7);

    await db.run(
      "UPDATE accounts SET current_balance_cents = 125000, available_balance_cents = 120000 WHERE id = ?",
      accountId,
    );
    await db.run(
      "INSERT INTO balance_history (id, account_id, date, balance_cents) VALUES (?, ?, ?, ?), (?, ?, ?, ?)",
      randomUUID(), accountId, `${month}-01`, 110000,
      randomUUID(), accountId, `${month}-15`, 125000,
    );
    await db.run(
      `INSERT INTO transactions
         (id, account_id, amount_cents, date, name, pending, is_transfer, source, created_at)
       VALUES (?, ?, ?, ?, 'Paycheck', 0, 0, 'manual', ?),
              (?, ?, ?, ?, 'Groceries', 0, 0, 'manual', ?),
              (?, ?, ?, ?, 'Pending coffee', 1, 0, 'manual', ?),
              (?, ?, ?, ?, 'Transfer', 0, 1, 'manual', ?)`,
      randomUUID(), accountId, 200000, `${month}-05`, now,
      randomUUID(), accountId, -5000, `${month}-06`, now,
      randomUUID(), accountId, -1200, `${month}-07`, now,
      randomUUID(), accountId, -25000, `${month}-08`, now,
    );

    const detail = await createAccountDetailService(db).get(user.id, accountId);

    expect(detail.account.name).toBe("Checking");
    expect(detail.account.pending_balance_cents).toBe(-1200);
    expect(detail.account.balance_with_pending_cents).toBe(123800);
    expect(detail.history.map((p) => p.balanceCents)).toEqual([110000, 125000]);
    expect(detail.activityTotal).toBe(4);
    expect(detail.recentActivity).toHaveLength(4);
    expect(detail.monthIncomeCents).toBe(200000);
    expect(detail.monthExpenseCents).toBe(5000);
    expect(detail.monthNetCents).toBe(195000);
  });

  it("surfaces provider liability metadata for the selected account", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "account-liability");
    const accountId = await seedManualAccount(db, user.id, "Visa", "credit");
    const connectionId = randomUUID();
    const now = new Date().toISOString();

    await db.run(
      `INSERT INTO provider_connections
         (id, user_id, provider, external_connection_id, institution_name, status, capabilities_json, created_at, updated_at)
       VALUES (?, ?, 'plaid', 'liability-item', 'Test Bank', 'active', '["liabilities"]', ?, ?)`,
      connectionId, user.id, now, now,
    );
    await db.run(
      `INSERT INTO liabilities
         (id, user_id, account_id, connection_id, provider, provider_external_account_id, kind,
          next_payment_due_date, minimum_payment_cents, statement_balance_cents, statement_date,
          next_monthly_payment_cents, apr_bps, last_payment_amount_cents, last_payment_date,
          raw_status, active, synced_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'plaid', 'visa-ext', 'credit_card',
          '2026-10-12', 3500, 84325, '2026-09-12', NULL, 1899, 5000, '2026-09-01',
          'current', 1, ?, ?, ?)`,
      randomUUID(), user.id, accountId, connectionId, now, now, now,
    );

    const detail = await createAccountDetailService(db).get(user.id, accountId);
    expect(detail.liability).toMatchObject({
      kind: "credit_card",
      nextPaymentDueDate: "2026-10-12",
      minimumPaymentCents: 3500,
      statementBalanceCents: 84325,
      aprBps: 1899,
      rawStatus: "current",
    });
  });

  it("surfaces synced holdings and computes account-level gains", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "account-holdings");
    const accountId = await seedManualAccount(db, user.id, "Brokerage", "investment");
    const connectionId = randomUUID();
    const securityId = randomUUID();
    const now = new Date().toISOString();

    await db.run(
      `INSERT INTO provider_connections
         (id, user_id, provider, external_connection_id, institution_name, status, capabilities_json, created_at, updated_at)
       VALUES (?, ?, 'plaid', 'invest-item', 'Brokerage Co', 'active', '["investments"]', ?, ?)`,
      connectionId, user.id, now, now,
    );
    await db.run(
      `INSERT INTO investment_securities
         (id, user_id, connection_id, provider, external_security_id, name, ticker, security_type, currency, updated_at)
       VALUES (?, ?, ?, 'plaid', 'sec-vti', 'Vanguard Total Stock Market ETF', 'VTI', 'equity', 'USD', ?)`,
      securityId, user.id, connectionId, now,
    );
    await db.run(
      `INSERT INTO investment_holdings
         (id, user_id, account_id, security_id, connection_id, provider, quantity,
          institution_price_cents, institution_value_cents, cost_basis_cents, currency, updated_at)
       VALUES (?, ?, ?, ?, ?, 'plaid', 10, 30000, 300000, 250000, 'USD', ?)`,
      randomUUID(), user.id, accountId, securityId, connectionId, now,
    );

    const detail = await createAccountDetailService(db).get(user.id, accountId);
    expect(detail.holdings).toHaveLength(1);
    expect(detail.holdings[0]).toMatchObject({
      ticker: "VTI",
      valueCents: 300000,
      costBasisCents: 250000,
      gainCents: 50000,
    });
    expect(detail.holdings[0].gainPct).toBeCloseTo(20);
  });
});