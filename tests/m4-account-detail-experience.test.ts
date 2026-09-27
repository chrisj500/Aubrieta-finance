import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const page = read("src/components/account-detail/account-detail-view.tsx");
const dynamicPage = read("src/app/(app)/accounts/[id]/page.tsx");
const staticPage = read("src/app/(app)/account/page.tsx");
const staticQuery = read("src/components/account-detail/account-detail-query.tsx");
const href = read("src/lib/account-detail-href.ts");
const accounts = read("src/app/(app)/accounts/page.tsx");
const route = read("src/app/api/accounts/[id]/route.ts");
const transactions = read("src/app/(app)/transactions/page.tsx");
const solo = read("src/lib/solo-router.ts");

describe("M4.8 Account Detail experience", () => {
  it("makes account names deep-link to per-account detail", () => {
    expect(accounts).toContain("href={accountDetailHref(a.id)}");
    expect(href).toContain('process.env.NEXT_PUBLIC_SOLO_BUILD === "1"');
    expect(href).toContain('`/account?id=${encoded}`');
    expect(href).toContain('`/accounts/${encoded}`');
    expect(accounts).toContain('aria-label={`Rename ${a.name}`}');
  });


  it("shares one detail implementation across server and static mobile/PWA entry points", () => {
    expect(dynamicPage).toContain("<AccountDetailView id={params.id} />");
    expect(staticPage).toContain("<AccountDetailFromQuery />");
    expect(staticQuery).toContain('params.get("id")');
    expect(staticQuery).toContain("<AccountDetailView id={id} />");
  });

  it("renders summary, balance history, and recent activity", () => {
    expect(page).toContain('label="Current balance"');
    expect(page).toContain('label="Available"');
    expect(page).toContain('label="This month"');
    expect(page).toContain("<CardTitle>Balance history</CardTitle>");
    expect(page).toContain("[30, 90, 365]");
    expect(page).toContain("<CardTitle>Recent activity</CardTitle>");
  });

  it("renders contextual debt and investment detail when available", () => {
    expect(page).toContain("<CardTitle>Debt details</CardTitle>");
    expect(page).toContain("<CardTitle>Holdings</CardTitle>");
    expect(page).toContain("data.liability.minimumPaymentCents");
    expect(page).toContain("holding.gainCents");
  });

  it("implements the registry-promised GET account endpoint with agent allowlist enforcement", () => {
    expect(route).toContain("export async function GET");
    expect(route).toContain('requireSessionOrAgent(req, ["read:banking", "read:investments"], "get_account")');
    expect(route).toContain("listForAgent");
    expect(route).toContain('throw apiErrors.notFound("Account")');
  });

  it("keeps the account detail endpoint available in solo mode", () => {
    expect(solo).toContain('method === "GET" && path.startsWith("/api/accounts/")');
    expect(solo).toContain("h.accountDetail.get(userId, id)");
  });

  it("deep-links All activity into the Transactions account filter", () => {
    expect(page).toContain('/transactions?accountId=${encodeURIComponent(a.id)}');
    expect(transactions).toContain('const accountFromUrl = url.get("accountId")');
    expect(transactions).toContain("if (accountFromUrl) setAccountId(accountFromUrl);");
  });
});
