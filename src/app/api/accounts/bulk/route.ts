import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, parseBody, route } from "@/lib/api";
import { requireCsrf, requireSession } from "@/server/auth/service";
import { createAccountsService } from "@/server/domain/accounts";
import { getDb } from "@/server/db/adapter";

export const runtime = "nodejs";

const schema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
  type: z.enum(["depository", "credit", "investment", "loan", "other"]).optional(),
  visibility: z.enum(["shared", "private"]).optional(),
  includeInNetWorth: z.boolean().optional(),
}).refine(
  (body) => body.type !== undefined || body.visibility !== undefined || body.includeInNetWorth !== undefined,
  { message: "Choose at least one bulk change." },
);

export async function PATCH(req: NextRequest) {
  return route(async (req) => {
    const session = await requireSession(req);
    requireCsrf(req);
    const body = await parseBody(schema, req);
    const updated = await createAccountsService(getDb()).bulkUpdate(session.userId, body.ids, body);
    return ok({ updated });
  })(req, { params: Promise.resolve({}) });
}
