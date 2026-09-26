import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const banner = readFileSync(path.resolve(__dirname, "../src/components/update-banner.tsx"), "utf8");
const card = readFileSync(path.resolve(__dirname, "../src/components/updates-card.tsx"), "utf8");
const registry = readFileSync(path.resolve(__dirname, "../src/server/authz/route-registry.ts"), "utf8");

describe("instance-level update controls", () => {
  it("does not render the global update banner for non-admin household users", () => {
    expect(banner).toContain("canManageUpdates: boolean");
    expect(banner).toContain("!s.canManageUpdates");
  });

  it("keeps update endpoints explicitly classified as user-only/non-agent", () => {
    expect(registry).toContain('"/api/updates"');
    expect(registry).toContain('"/api/updates/*"');
  });

  it("shows a read-only explanation instead of host controls in Settings", () => {
    expect(card).toContain("canManageUpdates: boolean");
    expect(card).toContain("if (s && !s.canManageUpdates)");
    expect(card).toContain("Instance updates are managed by the Aubrieta instance administrator.");
    expect(card).toContain("Host-level update controls are not available to this household user.");
  });
});
