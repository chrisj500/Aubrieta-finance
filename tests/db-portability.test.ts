import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOTS = ["src/server", "src/app/api"];
const SQLITE_ONLY_PREFIXES = [
  "src/server/db/",
];
const SQLITE_ONLY_FILES = new Set([
  "src/server/domain/backup.ts",
  "src/server/domain/solo-backup.ts",
  "src/server/db/migrations-bundle.ts",
]);

const FORBIDDEN: Array<[string, RegExp]> = [
  ["PRAGMA", /\bPRAGMA\b/i],
  ["sqlite_master", /\bsqlite_master\b/i],
  ["last_insert_rowid()", /\blast_insert_rowid\s*\(/i],
  ["INSERT OR IGNORE", /\bINSERT\s+OR\s+IGNORE\b/i],
  ["SQLite datetime() modifier arithmetic", /\bdatetime\s*\([^)]*,/i],
];

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full.replaceAll("\\", "/"));
  }
  return out;
}

function isStorageSpecific(file: string): boolean {
  return SQLITE_ONLY_FILES.has(file) || SQLITE_ONLY_PREFIXES.some((prefix) => file.startsWith(prefix));
}

describe("database portability guardrail", () => {
  it("keeps SQLite-only SQL out of shared application code", () => {
    const violations: string[] = [];
    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        if (isStorageSpecific(file)) continue;
        const source = fs.readFileSync(file, "utf8");
        for (const [label, pattern] of FORBIDDEN) {
          if (pattern.test(source)) violations.push(`${file}: ${label}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
