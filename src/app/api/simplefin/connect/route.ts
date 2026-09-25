import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, parseBody, route } from "@/lib/api";
import { requireCsrf, requireSession } from "@/server/auth/service";
import { getDb } from "@/server/db/adapter";
import { createSimpleFinService } from "@/server/simplefin/service";

export const runtime = "nodejs";

const schema = z.object({
  setupToken: z.string().min(1).max(8192),
});

export async function POST(req: NextRequest) {
  return route(async (req) => {
    const session = await requireSession(req);
    requireCsrf(req);
    const body = await parseBody(schema, req);
    return ok(await createSimpleFinService(getDb()).connectSetupToken(session.userId, body.setupToken));
  })(req, { params: Promise.resolve({}) });
}
