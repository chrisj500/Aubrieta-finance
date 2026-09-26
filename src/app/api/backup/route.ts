import { NextRequest, NextResponse } from "next/server";
import { route } from "@/lib/api";
import { requireSession } from "@/server/auth/service";
import { createBackupService } from "@/server/domain/backup";
import { getDb } from "@/server/db/adapter";
import { requireInstanceAdmin } from "@/server/authz/instance-admin";

export const runtime = "nodejs";

/** Download the encrypted whole-instance SQLite backup. Instance-admin session only. */
export async function GET(req: NextRequest) {
  return route(async (req) => {
    const session = await requireSession(req);
    await requireInstanceAdmin(getDb(), session.userId);
    const buf = await createBackupService(getDb()).exportBackup();
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="open-finance-${new Date().toISOString().slice(0, 10)}.ofbak"`,
      },
    });
  })(req, { params: Promise.resolve({}) });
}
