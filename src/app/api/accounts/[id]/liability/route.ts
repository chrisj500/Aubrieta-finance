import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, parseBody, parseParam, route } from "@/lib/api";
import { requireCsrf, requireSession } from "@/server/auth/service";
import { getDb } from "@/server/db/adapter";
import { createAccountLiabilityOverrideService } from "@/server/domain/account-liability-overrides";

export const runtime = "nodejs";

const schema = z.object({
  dueDay: z.number().int().min(1).max(31).nullable().optional(),
  aprPct: z.number().min(0).max(999.99).nullable().optional(),
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return route(async (req, ctx) => {
    const session = await requireSession(req);
    requireCsrf(req);
    const id = await parseParam(ctx, "id");
    const body = await parseBody(schema, req);
    const value = await createAccountLiabilityOverrideService(getDb()).set(session.userId, id, {
      dueDay: body.dueDay,
      aprBps: body.aprPct === undefined ? undefined : body.aprPct === null ? null : Math.round(body.aprPct * 100),
    });
    return ok({ liabilityOverride: value });
  })(req, ctx);
}
