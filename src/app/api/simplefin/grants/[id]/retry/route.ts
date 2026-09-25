import { NextRequest } from "next/server";
import { ok, parseParam, route } from "@/lib/api";
import { requireCsrf, requireSession } from "@/server/auth/service";
import { getDb } from "@/server/db/adapter";
import { createSimpleFinService } from "@/server/simplefin/service";

export const runtime = "nodejs";

export async function POST(req: NextRequest, ctx: { params: Promise<Record<string, string>> }) {
  return route(async (req, ctx) => {
    const session = await requireSession(req);
    requireCsrf(req);
    const id = await parseParam(ctx, "id");
    return ok(await createSimpleFinService(getDb()).retryGrant(session.userId, id));
  })(req, ctx);
}
