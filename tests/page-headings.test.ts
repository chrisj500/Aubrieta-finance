import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

// Every main page needs a per-page heading so screen-reader / heading-navigation
// users hear the current section name. The app-shell header <h1> shows the user's
// display name on every route, so these sr-only page headings are what actually
// announce the current section, including the visible Overview heading.
// (accounts + agents already have visible headings; M4 is migrating the remaining legacy pages as each experience is refreshed.)
describe("main pages expose a per-page heading", () => {
  it("overview page has a visible page heading", () => {
    const src = read("src/app/(app)/dashboard/page.tsx");
    expect(src).toContain('title="Overview"');
  });

  it("transactions page has a visible page heading", () => {
    const src = read("src/app/(app)/transactions/page.tsx");
    expect(src).toContain('title="Transactions"');
  });

  it("plan page has a visible page heading", () => {
    const src = read("src/app/(app)/plan/page.tsx");
    expect(src).toContain('title="Plan"');
  });

  it("budgets page has a visible page heading", () => {
    const src = read("src/app/(app)/budgets/page.tsx");
    expect(src).toContain('title="Budgets"');
  });

  const cases: Array<[string, string]> = [
    ["reports", "src/app/(app)/reports/page.tsx"],
    ["settings", "src/app/(app)/settings/page.tsx"],
  ];
  for (const [name, file] of cases) {
    it(`${name} page has an sr-only page heading`, () => {
      const src = read(file);
      expect(src).toContain(`<h1 className="sr-only">${name[0].toUpperCase()}${name.slice(1)}</h1>`);
    });
  }
});
