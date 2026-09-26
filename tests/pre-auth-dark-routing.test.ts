import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const source = readFileSync(join(root, "src/components/pre-auth-dark.tsx"), "utf8");

function shellPaths(): string[] {
  const block = source.match(/const APP_SHELL_PATHS = \[([\s\S]*?)\];/);
  if (!block) throw new Error("APP_SHELL_PATHS not found");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("PreAuthDark app-shell routing", () => {
  it("does not force dark mode on every authenticated finance destination", () => {
    const paths = shellPaths();
    expect(paths).toEqual(expect.arrayContaining([
      "/dashboard",
      "/accounts",
      "/account",
      "/investments",
      "/transactions",
      "/budgets",
      "/plan",
      "/reports",
      "/agents",
      "/settings",
    ]));
  });

  it("keeps forced-dark scoped to routes outside the authenticated app shell", () => {
    expect(source).toContain('const preAuth = !APP_SHELL_PATHS.some((p) => pathname.startsWith(p));');
    expect(source).toContain('className={preAuth ? "forced-dark min-h-screen" : undefined}');
  });
});
