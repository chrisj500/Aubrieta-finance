import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("CLI demo seed household compatibility", () => {
  it("creates an owner household and scopes all seeded financial objects after M3", () => {
    const dir = mkdtempSync(join(tmpdir(), "aubrieta-demo-seed-"));
    dirs.push(dir);
    const dbPath = join(dir, "open-finance.db");

    execFileSync(process.execPath, ["scripts/seed.js", "--seed-date", "2026-09-25"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_PATH: dbPath },
      stdio: "pipe",
    });

    const db = new Database(dbPath, { readonly: true });
    try {
      const demo = db.prepare("SELECT id FROM users WHERE username = 'demo'").get() as { id: string };
      const member = db.prepare(
        "SELECT household_id, role FROM household_members WHERE user_id = ?",
      ).get(demo.id) as { household_id: string; role: string };

      expect(member.role).toBe("owner");
      expect(member.household_id).toBe(`household:${demo.id}`);

      const populatedTables = new Set(["accounts", "bills", "goals", "debts"]);
      for (const table of ["accounts", "budgets", "bills", "goals", "debts"]) {
        const counts = db.prepare(
          `SELECT COUNT(*) AS total,\n                  COALESCE(SUM(CASE WHEN household_id = ? AND owner_user_id = ? AND visibility = 'shared' THEN 1 ELSE 0 END), 0) AS scoped\n             FROM ${table}\n            WHERE user_id = ?`,
        ).get(member.household_id, demo.id, demo.id) as { total: number; scoped: number };
        if (populatedTables.has(table)) expect(counts.total).toBeGreaterThan(0);
        expect(counts.scoped).toBe(counts.total);
      }
    } finally {
      db.close();
    }
  });
});