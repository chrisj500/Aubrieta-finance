import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const src = readFileSync(join(root, "src/app/(app)/settings/page.tsx"), "utf8");

// Settings IA regroup (run 122): groups must be logically scoped and the
// Financial-data connections now live on Data & Sync; Settings keeps device/planning configuration.
describe("settings information architecture", () => {
  it("keeps only planning/device data in Settings", () => {
    expect(src).toContain(
      '<SettingsGroup title="Planning & device data" description="Pay schedule, hub pairing, and phone-data migration.">'
    );
    expect(src).not.toContain('<SettingsGroup title="Data & sync"');
    expect(src).not.toContain("ConnectionHealthCard");
    expect(src).not.toContain("SimpleFinSettingsCard");
  });

  it("keeps the backup group title casing consistent and mentions the tour", () => {
    expect(src).toContain(
      '<SettingsGroup title="Backup & updates" description="Backups, the setup tour, and app updates.">'
    );
    expect(src).not.toContain('<SettingsGroup title="Backup & Updates"');
  });

  it("keeps SetupTourCard in Backup & updates", () => {
    const backupStart = src.indexOf('title="Backup & updates"');
    const backupEnd = src.indexOf("</SettingsGroup>", backupStart);
    expect(backupStart).toBeGreaterThan(-1);

    const backupBlock = src.slice(backupStart, backupEnd);
    expect(backupBlock).toContain("{!solo && <SetupTourCard setErr={setErr} />}");
    // BackupPanel renders before the tour, tour before UpdatesCard
    expect(backupBlock.indexOf("<BackupPanel")).toBeLessThan(backupBlock.indexOf("SetupTourCard"));
    expect(backupBlock.indexOf("SetupTourCard")).toBeLessThan(backupBlock.indexOf("<UpdatesCard"));
  });
});
