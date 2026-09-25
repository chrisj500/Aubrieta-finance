import { NextRequest } from "next/server";
import { noContent, parseParam, route } from "@/lib/api";
import { requireCsrf, requireSession } from "@/server/auth/service";
import { getDb } from "@/server/db/adapter";
import { createSimpleFinService } from "@/server/simplefin/service";

export const runtime = "nodejs";

export async function DELETE(req: NextRequest, ctx: { params: Promise<Record<string, string>> }) {
  return route(async (req, ctx) => {
    const session = await requireSession(req);
    requireCsrf(req);
    const id = await parseParam(ctx, "id");
    await createSimpleFinService(getDb()).discardGrant(session.userId, id);
    return noContent();
  })(req, ctx);
}
