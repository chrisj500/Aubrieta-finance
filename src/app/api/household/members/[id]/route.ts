import { NextRequest } from "next/server";
import { noContent, parseParam, route } from "@/lib/api";
import { requireCsrf, requireSession } from "@/server/auth/service";
import { getDb } from "@/server/db/adapter";
import { createHouseholdService } from "@/server/domain/households";

export const runtime = "nodejs";

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return route(async (req, ctx) => {
    const session = await requireSession(req);
    requireCsrf(req);
    const memberId = await parseParam(ctx, "id");
    await createHouseholdService(getDb()).removeMember(session.userId, memberId);
    return noContent();
  })(req, ctx);
}