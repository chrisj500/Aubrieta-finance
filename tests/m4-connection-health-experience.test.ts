import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const settings = read("src/app/(app)/settings/page.tsx");
const card = read("src/components/connection-health-card.tsx");
const route = read("src/app/api/connections/health/route.ts");
const solo = read("src/lib/solo-router.ts");
const registry = read("src/server/authz/route-registry.ts");
const teller = read("src/components/teller-settings-card.tsx");
const simplefin = read("src/components/simplefin-settings-card.tsx");
const akoya = read("src/components/akoya-settings-card.tsx");

describe("M4.9 Connection Health experience", () => {
  it("puts provider-neutral connection health ahead of provider setup controls", () => {
    expect(settings).toContain("<ConnectionHealthCard setMsg={setMsg} setErr={setErr} />");
    expect(settings.indexOf("<ConnectionHealthCard")).toBeLessThan(settings.indexOf('id="provider-plaid"'));
  });

  it("shows real recorded status, last successful sync, errors, accounts, and capabilities", () => {
    expect(card).toContain('queryKey: ["connection-health"]');
    expect(card).toContain('api.get<ConnectionHealthResult>("/api/connections/health")');
    expect(card).toContain("Last successful sync");
    expect(card).toContain("connection.lastError");
    expect(card).toContain("connection.accountNames.join");
    expect(card).toContain('Capabilities: {connection.capabilities.join(" · ")}');
    expect(card).toContain("Needs attention");
    expect(card).toContain("Healthy");
  });

  it("reuses the existing provider-neutral sync endpoint instead of inventing a second sync engine", () => {
    expect(card).toContain('api.post<');
    expect(card).toContain('>("/api/transactions/sync")');
    expect(card).toContain("Refresh all");
  });

  it("keeps connection health session-only and explicit in the route registry", () => {
    expect(route).toContain("requireSession(req)");
    expect(route).not.toContain("requireSessionOrAgent");
    expect(registry).toContain('"/api/connections/*"');
  });

  it("keeps the health endpoint available in solo mode with local Plaid reauth state", () => {
    expect(solo).toContain('method === "GET" && path === "/api/connections/health"');
    expect(solo).toContain('item.status === "login_required"');
    expect(solo).toContain('state: attention ? ("needs_attention" as const)');
  });

  it("anchors every provider management surface and refreshes health after connection changes", () => {
    expect(settings).toContain('id="provider-plaid"');
    expect(teller).toContain('id="provider-teller"');
    expect(simplefin).toContain('id="provider-simplefin"');
    expect(akoya).toContain('id="provider-akoya"');
    for (const source of [settings, teller, simplefin, akoya]) {
      expect(source).toContain('queryKey: ["connection-health"]');
    }
  });
});
