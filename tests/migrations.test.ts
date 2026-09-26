import { createRequire } from "node:module";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { runMigrations } = require(path.resolve("migrations/up.js"));

const TABLES = [
  "users", "sessions", "device_lock", "plaid_credentials", "plaid_items",
  "accounts", "balance_history", "transactions", "categories", "budgets",
  "budget_categories", "user_settings", "bills", "debts", "goals",
  "agent_tokens", "agent_access_log", "agent_permission_requests",
  "custom_views", "pairing_codes", "households", "household_members", "household_invitations", "households", "household_members",
  "household_invitations",
];

describe("migrations", () => {
  it("applies the full schema from an empty database", () => {
    const db = new Database(":memory:");
    const r = runMigrations(db);
    expect(r.applied).toBeGreaterThan(0);
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    for (const t of TABLES) expect(rows.map((x) => x.name)).toContain(t);
    db.close();
  });

  it("is idempotent — second run applies nothing", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const r2 = runMigrations(db);
    expect(r2.applied).toBe(0);
    db.close();
  });

  it("tracks version in _migrations and PRAGMA user_version", () => {
    const db = new Database(":memory:");
    const r = runMigrations(db);
    const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(row.user_version).toBe(r.current);
    db.close();
  });

  it("no migration may ever overwrite user-owned agent_manual rows", () => {
    // User-authored AI guidance lives in agent_manual (D11). A migration must
    // never INSERT/UPDATE/REPLACE/DELETE into it — that would clobber the
    // user's custom instructions on app update. Only DDL (CREATE TABLE,
    // ALTER TABLE ADD COLUMN) is permitted. If a future default/seed is ever
    // wanted, it must be additive and user-merged, never a blind write.
    const fs = require("fs");
    const path = require("path");
    const dir = path.resolve("migrations");
    const files = fs.readdirSync(dir).filter((f: string) => /^\d+_.*\.sql$/.test(f));
    for (const f of files) {
      const sql = fs.readFileSync(path.join(dir, f), "utf8");
      // Strip comments and string literals so we only match real DML.
      const cleaned = sql.replace(/--.*$/gm, "").replace(/'[^']*'/g, "''");
      const matches = cleaned.match(/INSERT|UPDATE|REPLACE|DELETE|UPSERT/gi) || [];
      for (const verb of matches) {
        const near = cleaned.toUpperCase();
        if (near.includes(` ${verb.toUpperCase()} `) && /AGENT_MANUAL/.test(near)) {
          throw new Error(
            `Migration ${f} writes to agent_manual (${verb}) — this would overwrite user instructions. Use DDL only.`
          );
        }
      }
    }
  });

  it("backfills existing single-user finance data into a household", () => {
    const fs = require("fs");
    const path = require("path");
    const db = new Database(":memory:");
    const dir = path.resolve("migrations");
    const files = fs
      .readdirSync(dir)
      .filter((name: string) => /^\d+_.*\.sql$/.test(name))
      .sort((a: string, b: string) => parseInt(a, 10) - parseInt(b, 10));
    const preHousehold = files.filter((name: string) => parseInt(name, 10) < 26);
    for (const name of preHousehold) {
      db.exec(fs.readFileSync(path.join(dir, name), "utf8"));
    }

    const ts = "2026-09-25T00:00:00.000Z";
    db.prepare(
      "INSERT INTO users (id, username, display_name, password_hash, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ).run("u1", "legacy", "Legacy User", "x", ts, ts);
    db.prepare(
      "INSERT INTO accounts (id, user_id, name, currency, created_at) VALUES (?,?,?,?,?)",
    ).run("a1", "u1", "Checking", "USD", ts);
    db.prepare(
      "INSERT INTO budgets (id, user_id, name, amount_cents, period, created_at) VALUES (?,?,?,?,?,?)",
    ).run("bu1", "u1", "Food", 50000, "monthly", ts);
    db.prepare(
      "INSERT INTO bills (id, user_id, name, amount_cents, frequency, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    ).run("bi1", "u1", "Rent", 150000, "monthly", ts, ts);
    db.prepare(
      "INSERT INTO debts (id, user_id, name, principal_cents, start_date, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    ).run("d1", "u1", "Loan", 100000, "2026-01-01", ts, ts);
    db.prepare(
      "INSERT INTO goals (id, user_id, name, target_cents, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ).run("g1", "u1", "Emergency fund", 200000, ts, ts);

    const householdMigration = files.find((name: string) => parseInt(name, 10) === 26);
    expect(householdMigration).toBeTruthy();
    db.exec(fs.readFileSync(path.join(dir, householdMigration), "utf8"));

    const membership = db.prepare(
      "SELECT household_id, role FROM household_members WHERE user_id = 'u1'",
    ).get() as { household_id: string; role: string };
    expect(membership).toEqual({ household_id: "household:u1", role: "owner" });

    for (const [table, id] of [
      ["accounts", "a1"],
      ["budgets", "bu1"],
      ["bills", "bi1"],
      ["debts", "d1"],
      ["goals", "g1"],
    ] as const) {
      const row = db.prepare(
        `SELECT household_id, owner_user_id, visibility FROM ${table} WHERE id = ?`,
      ).get(id) as { household_id: string; owner_user_id: string; visibility: string };
      expect(row).toEqual({
        household_id: "household:u1",
        owner_user_id: "u1",
        visibility: "shared",
      });
    }
    db.close();
  });

  it("backfills existing single-user data into a default household", () => {
    const fs = require("fs");
    const dir = path.resolve("migrations");
    const files = fs.readdirSync(dir)
      .filter((f: string) => /^\d+_.*\.sql$/.test(f))
      .sort((a: string, b: string) => parseInt(a, 10) - parseInt(b, 10));
    const db = new Database(":memory:");
    for (const f of files.filter((f: string) => parseInt(f, 10) < 26)) {
      db.exec(fs.readFileSync(path.join(dir, f), "utf8"));
    }
    const ts = "2026-09-25T12:00:00.000Z";
    db.prepare(
      "INSERT INTO users (id, username, display_name, password_hash, created_at, updated_at) VALUES (?,?,?,?,?,?)"
    ).run("u1", "alice", "Alice", "hash", ts, ts);
    db.prepare(
      "INSERT INTO accounts (id, user_id, name, type, currency, created_at) VALUES (?,?,?,?,?,?)"
    ).run("a1", "u1", "Checking", "depository", "USD", ts);
    db.prepare(
      "INSERT INTO bills (id, user_id, name, amount_cents, frequency, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
    ).run("b1", "u1", "Rent", 150000, "monthly", ts, ts);

    db.exec(fs.readFileSync(path.join(dir, "026_household_model.sql"), "utf8"));

    expect(db.prepare("SELECT role FROM household_members WHERE user_id = 'u1'").get()).toMatchObject({ role: "owner" });
    expect(db.prepare("SELECT household_id, owner_user_id, visibility FROM accounts WHERE id = 'a1'").get()).toMatchObject({
      household_id: "household:u1", owner_user_id: "u1", visibility: "shared",
    });
    expect(db.prepare("SELECT household_id, owner_user_id, visibility FROM bills WHERE id = 'b1'").get()).toMatchObject({
      household_id: "household:u1", owner_user_id: "u1", visibility: "shared",
    });
    db.close();
  });

  it("stores a manual transaction row", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    db.prepare(
      "INSERT INTO transactions (id, account_id, amount_cents, date, name, source, created_at) VALUES (?,?,?,?,?,?,?)"
    ).run("t1", "a1", 1000, "2026-01-01", "Test", "manual", "2026-01-01T00:00:00Z");
    const row = db.prepare("SELECT amount_cents, source FROM transactions WHERE id='t1'").get() as {
      amount_cents: number;
      source: string;
    };
    expect(row.amount_cents).toBe(1000);
    expect(row.source).toBe("manual");
    db.close();
  });
});