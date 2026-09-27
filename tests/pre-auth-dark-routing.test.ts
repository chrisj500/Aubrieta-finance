import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const source = readFileSync(join(root, "src/components/pre-auth-dark.tsx"), "utf8");
const sidebar = readFileSync(join(root, "src/components/sidebar.tsx"), "utf8");

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
      "/data-sync",
      "/settings",
    ]));
  });


  it("keeps every first-class sidebar destination theme-aware", () => {
    const paths = shellPaths();
    const navBlock = sidebar.match(/const NAV = \[([\s\S]*?)\];/);
    if (!navBlock) throw new Error("sidebar NAV not found");
    const navPaths = [...navBlock[1].matchAll(/href: "([^"]+)"/g)].map((m) => m[1]);

    for (const href of navPaths) {
      expect(paths, `${href} must be part of the authenticated app shell so light/dark mode can control it`).toContain(href);
    }
  });

  it("keeps forced-dark scoped to routes outside the authenticated app shell", () => {
    expect(source).toContain('const preAuth = !APP_SHELL_PATHS.some((p) => pathname.startsWith(p));');
    expect(source).toContain('className={preAuth ? "forced-dark min-h-screen" : undefined}');
  });
});
