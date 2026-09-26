import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { env } from "@/lib/env";
import { apiErrors } from "@/lib/api";
import { verifyPassword } from "@/server/auth/password";
import { getDb, type Db } from "@/server/db/adapter";

/**
 * Backup & restore.
 *
 * Backup = the SQLite file, encrypted at rest with AES-256-GCM under the same
 * ENCRYPTION_KEY the install uses (so a backup is useless without the key that
 * produced it — restore requires the same ENCRYPTION_KEY).
 *
 * Restore = password-confirmed (agent tokens can never restore), validates and
 * migrates a same-directory staging DB before touching the live file, writes an
 * encrypted pre-restore safety backup, then swaps atomically with rollback if
 * activation/reopen fails. Wrong key → GCM auth failure → clean 400.
 */

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const AAD = "open-finance:backup:v1";

/**
 * Hard cap on an uploaded .ofbak envelope (512 MB). A personal-finance SQLite
 * DB is at most tens of MB; the cap exists so a hostile or misconfigured
 * upload cannot exhaust server memory — restore buffers the whole file into
 * RAM (arrayBuffer → Buffer) before decrypting.
 */
export const MAX_BACKUP_BYTES = 512 * 1024 * 1024;

export function assertBackupSize(declaredContentLength: string | null, fileSize: number | null): void {
  const declared = declaredContentLength === null ? NaN : Number(declaredContentLength);
  if (
    (Number.isFinite(declared) && declared > MAX_BACKUP_BYTES) ||
    (fileSize !== null && fileSize > MAX_BACKUP_BYTES)
  ) {
    throw apiErrors.payloadTooLarge("Backup file is too large (limit 512 MB).");
  }
}

function key(): Buffer {
  return createHash("sha256").update(env.ENCRYPTION_KEY).digest();
}

/** Encrypt the whole SQLite file into a portable .ofbak envelope. */
export function encryptBackup(dbPath: string): Buffer {
  const plaintext = fs.readFileSync(dbPath);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key(), iv);
  cipher.setAAD(Buffer.from(AAD, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from("OFBAK1", "utf8"), iv, tag, ct]);
}

/** Decrypt a backup envelope; throws (→ 400) on wrong key / tamper. */
export function decryptBackup(envelope: Buffer): Buffer {
  const magic = Buffer.from("OFBAK1", "utf8");
  if (envelope.length < magic.length + IV_LEN + TAG_LEN + 1 || !envelope.subarray(0, magic.length).equals(magic)) {
    throw apiErrors.badRequest("Not a valid Open Finance backup file.");
  }
  const iv = envelope.subarray(magic.length, magic.length + IV_LEN);
  const tag = envelope.subarray(magic.length + IV_LEN, magic.length + IV_LEN + TAG_LEN);
  const ct = envelope.subarray(magic.length + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key(), iv);
  decipher.setAAD(Buffer.from(AAD, "utf8"));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw apiErrors.badRequest(
      "This backup cannot be decrypted with this install's ENCRYPTION_KEY. Restore it on the machine that created it (or with the same key)."
    );
  }
}

type RawSqlite = {
  pragma(source: string, options?: { simple?: boolean }): unknown;
  exec(source: string): void;
  close(): void;
};

type RawSqliteConstructor = new (filename: string) => RawSqlite;

function sqliteRuntime(): {
  Database: RawSqliteConstructor;
  runMigrations: (db: RawSqlite, dir?: string) => { applied: number; current: number };
  migrationsDir: string;
} {
  const require = createRequire(import.meta.url);
  const Database: RawSqliteConstructor = require("better-sqlite3");
  const { runMigrations }: {
    runMigrations: (db: RawSqlite, dir?: string) => { applied: number; current: number };
  } = require("../../../migrations/up.js");
  return { Database, runMigrations, migrationsDir: path.resolve(process.cwd(), "migrations") };
}

function latestMigrationVersion(migrationsDir: string): number {
  const versions = fs
    .readdirSync(migrationsDir)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .map((name) => Number.parseInt(name, 10))
    .filter(Number.isFinite);
  if (versions.length === 0) throw new Error("No database migrations are available.");
  return Math.max(...versions);
}

function assertSqliteIntegrity(db: RawSqlite, phase: string): void {
  const result = db.pragma("quick_check", { simple: true });
  if (result !== "ok") {
    throw apiErrors.badRequest(`Backup database failed SQLite integrity validation (${phase}).`);
  }
}

function removeSqliteSidecars(dbPath: string): void {
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
}

function uniqueSibling(dbPath: string, label: string, extension = ".db"): string {
  const suffix = `${Date.now()}-${randomBytes(8).toString("hex")}`;
  return path.join(path.dirname(dbPath), `${label}-${suffix}${extension}`);
}

function validateAndMigrateStaging(stagingPath: string): number {
  const { Database, runMigrations, migrationsDir } = sqliteRuntime();
  const expectedVersion = latestMigrationVersion(migrationsDir);
  let raw: RawSqlite | null = null;
  try {
    raw = new Database(stagingPath);
    assertSqliteIntegrity(raw, "before migration");
    const migration = runMigrations(raw, migrationsDir);
    assertSqliteIntegrity(raw, "after migration");
    const userVersion = Number(raw.pragma("user_version", { simple: true }));
    if (migration.current !== expectedVersion || userVersion !== expectedVersion) {
      throw apiErrors.badRequest("Backup database did not migrate to the current schema version.");
    }
    raw.pragma("wal_checkpoint(FULL)");
    raw.pragma("journal_mode = DELETE");
    return expectedVersion;
  } catch (error) {
    if (error instanceof Error && "status" in error) throw error;
    throw apiErrors.badRequest("Backup database could not be validated and migrated.");
  } finally {
    try {
      raw?.close();
    } catch {
      // best effort cleanup; validation result is already determined
    }
  }
}

function validateActivatedDatabase(dbPath: string, expectedVersion: number): void {
  const { Database } = sqliteRuntime();
  let raw: RawSqlite | null = null;
  try {
    raw = new Database(dbPath);
    assertSqliteIntegrity(raw, "after activation");
    const userVersion = Number(raw.pragma("user_version", { simple: true }));
    if (userVersion !== expectedVersion) throw new Error("Activated database schema version mismatch.");
  } finally {
    try {
      raw?.close();
    } catch {
      // activation failure is handled by the caller's rollback path
    }
  }
}

export interface RestoreResult {
  restored: true;
  preRestoreBackupPath: string | null;
}

export function createBackupService(db: Db = getDb(), dbPathOverride?: string) {
  const dbPath = () => dbPathOverride ?? env.DATABASE_PATH;
  const usesSingleton = dbPathOverride === undefined;

  async function exportBackup(): Promise<Buffer> {
    const p = dbPath();
    if (!fs.existsSync(p)) throw apiErrors.notFound("Database file");
    await db.run("PRAGMA wal_checkpoint(FULL)");
    return encryptBackup(p);
  }

  async function restoreBackup(
    userId: string,
    envelope: Buffer,
    confirmPassword: string
  ): Promise<RestoreResult> {
    const user = await db.get<{ id: string; password_hash: string | null }>(
      "SELECT id, password_hash FROM users WHERE id = ?",
      userId
    );
    if (!user?.password_hash || !(await verifyPassword(confirmPassword, user.password_hash))) {
      throw apiErrors.forbidden("Password confirmation failed. Restore aborted.");
    }

    const plaintext = decryptBackup(envelope);
    if (!plaintext.subarray(0, 16).equals(Buffer.from("SQLite format 3\u0000"))) {
      throw apiErrors.badRequest("Decrypted backup is not a valid SQLite database.");
    }

    const p = dbPath();
    const dir = path.dirname(p);
    fs.mkdirSync(dir, { recursive: true });
    const stagingPath = uniqueSibling(p, "restore-staging");
    const rollbackPath = uniqueSibling(p, "restore-rollback");
    let preRestoreBackupPath: string | null = null;
    let liveMovedToRollback = false;
    let stagingActivated = false;

    try {
      fs.writeFileSync(stagingPath, plaintext, { flag: "wx", mode: 0o600 });
      const expectedVersion = validateAndMigrateStaging(stagingPath);

      if (fs.existsSync(p)) {
        // Make the durable safety artifact encrypted; the plaintext rollback file
        // exists only during the activation window and is deleted on success.
        await db.run("PRAGMA wal_checkpoint(FULL)");
        preRestoreBackupPath = uniqueSibling(p, "pre-restore", ".ofbak");
        fs.writeFileSync(preRestoreBackupPath, encryptBackup(p), { flag: "wx", mode: 0o600 });
      }

      const { resetDb, SqliteDb } = await import("@/server/db/adapter");
      if (usesSingleton) {
        resetDb();
      } else if (db instanceof SqliteDb) {
        try {
          db.close();
        } catch {
          // already closed
        }
      }
      removeSqliteSidecars(p);

      if (fs.existsSync(p)) {
        fs.renameSync(p, rollbackPath);
        liveMovedToRollback = true;
      }
      fs.renameSync(stagingPath, p);
      stagingActivated = true;

      try {
        validateActivatedDatabase(p, expectedVersion);
        if (usesSingleton) {
          const reopened = getDb();
          await reopened.get("SELECT 1 AS ok");
        }
      } catch (activationError) {
        if (usesSingleton) resetDb();
        removeSqliteSidecars(p);
        fs.rmSync(p, { force: true });
        if (liveMovedToRollback && fs.existsSync(rollbackPath)) {
          fs.renameSync(rollbackPath, p);
          liveMovedToRollback = false;
          if (usesSingleton) {
            const reopenedOriginal = getDb();
            await reopenedOriginal.get("SELECT 1 AS ok");
          }
        }
        throw activationError;
      }

      if (liveMovedToRollback) {
        fs.rmSync(rollbackPath, { force: true });
        liveMovedToRollback = false;
      }
      return { restored: true, preRestoreBackupPath };
    } catch (error) {
      if (!stagingActivated) fs.rmSync(stagingPath, { force: true });
      if (liveMovedToRollback && fs.existsSync(rollbackPath) && !fs.existsSync(p)) {
        fs.renameSync(rollbackPath, p);
      }
      throw error;
    } finally {
      fs.rmSync(stagingPath, { force: true });
      if (!liveMovedToRollback) fs.rmSync(rollbackPath, { force: true });
      removeSqliteSidecars(stagingPath);
      removeSqliteSidecars(rollbackPath);
    }
  }

  return { exportBackup, restoreBackup };
}

export type BackupService = ReturnType<typeof createBackupService>;
