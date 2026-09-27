import type { Db } from "@/server/db/types";
import { assertAccountManageable } from "@/server/authz/household-access";
import { validateIconDataUrl } from "@/server/domain/icon-image";

export interface AccountIconRow {
  accountId: string;
  dataUrl: string;
  mimeType: string;
  sizeBytes: number;
}

export function createAccountIconService(db: Db) {
  return {
    async list(userId: string): Promise<AccountIconRow[]> {
      const rows = await db.all<{ account_id: string; data_url: string; mime_type: string; size_bytes: number }>(
        `SELECT aio.account_id, aio.data_url, aio.mime_type, aio.size_bytes
           FROM account_icon_overrides aio
           JOIN accounts a ON a.id = aio.account_id
          WHERE aio.user_id = ? AND a.deleted_at IS NULL
          ORDER BY aio.account_id`,
        userId,
      );
      return rows.map((row) => ({ accountId: row.account_id, dataUrl: row.data_url, mimeType: row.mime_type, sizeBytes: row.size_bytes }));
    },

    async set(userId: string, accountId: string, dataUrl: string): Promise<AccountIconRow> {
      await assertAccountManageable(db, userId, accountId);
      const image = validateIconDataUrl(dataUrl);
      const now = new Date().toISOString();
      const existing = await db.get<{ account_id: string }>(
        "SELECT account_id FROM account_icon_overrides WHERE account_id = ? AND user_id = ?",
        accountId,
        userId,
      );
      if (existing) {
        await db.run(
          `UPDATE account_icon_overrides
              SET data_url = ?, mime_type = ?, size_bytes = ?, updated_at = ?
            WHERE account_id = ? AND user_id = ?`,
          dataUrl,
          image.mimeType,
          image.sizeBytes,
          now,
          accountId,
          userId,
        );
      } else {
        await db.run(
          `INSERT INTO account_icon_overrides
           (account_id, user_id, data_url, mime_type, size_bytes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          accountId,
          userId,
          dataUrl,
          image.mimeType,
          image.sizeBytes,
          now,
          now,
        );
      }
      return { accountId, dataUrl, mimeType: image.mimeType, sizeBytes: image.sizeBytes };
    },

    async remove(userId: string, accountId: string): Promise<void> {
      await assertAccountManageable(db, userId, accountId);
      await db.run("DELETE FROM account_icon_overrides WHERE account_id = ? AND user_id = ?", accountId, userId);
    },
  };
}
