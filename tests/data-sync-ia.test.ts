import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const page = read("src/app/(app)/data-sync/page.tsx");
const sidebar = read("src/components/sidebar.tsx");

describe("Data & Sync information architecture", () => {
  it("surfaces Data & Sync in desktop and mobile navigation", () => {
    expect(sidebar).toContain('{ href: "/data-sync", label: "Data & Sync", Icon: Database }');
    expect(sidebar).toContain('blurb: "Connections, health & imports"');
  });

  it("centralizes connection health, active providers, and CSV import", () => {
    expect(page).toContain("Data & Connection Health");
    expect(page).toContain("<ConnectionHealthCard");
    expect(page).toContain("<PlaidSettingsCard");
    expect(page).toContain("<SimpleFinSettingsCard");
    expect(page).toContain("<AkoyaSettingsCard");
    expect(page).toContain("<CsvImportCard");
    expect(page).toContain("<DataQualityCard");
    expect(page).not.toContain("TellerSettingsCard");
  });
});
