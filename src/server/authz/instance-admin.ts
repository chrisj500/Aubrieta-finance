import { apiErrors } from "@/lib/api-error";
import type { Db } from "@/server/db/types";

/** Instance administration is deliberately separate from household membership. */
export async function isInstanceAdmin(db: Db, userId: string): Promise<boolean> {
  const row = await db.get<{ user_id: string }>(
    "SELECT user_id FROM instance_admins WHERE user_id = ?",
    userId,
  );
  return !!row;
}

export async function requireInstanceAdmin(db: Db, userId: string): Promise<void> {
  if (!(await isInstanceAdmin(db, userId))) {
    throw apiErrors.forbidden("Instance administrator access is required.");
  }
}
