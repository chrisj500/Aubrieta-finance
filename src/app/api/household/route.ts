import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, parseBody, route } from "@/lib/api";
import { requireCsrf, requireSession } from "@/server/auth/service";
import { getDb } from "@/server/db/adapter";
import { createHouseholdService } from "@/server/domain/households";

export const runtime = "nodejs";

const patchSchema = z.object({
  name: z.string().min(1).max(80),
});

export async function GET(req: NextRequest) {
  return route(async (req) => {
    const session = await requireSession(req);
    const household = await createHouseholdService(getDb()).get(session.userId);
    return ok({ household });
  })(req, { params: Promise.resolve({}) });
}

export async function PATCH(req: NextRequest) {
  return route(async (req) => {
    const session = await requireSession(req);
    requireCsrf(req);
    const body = await parseBody(patchSchema, req);
    const svc = createHouseholdService(getDb());
    await svc.rename(session.userId, body.name);
    return ok({ household: await svc.get(session.userId) });
  })(req, { params: Promise.resolve({}) });
}