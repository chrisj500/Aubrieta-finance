import { NextRequest } from "next/server";
import { z } from "zod";
import { noContent, parseBody, route } from "@/lib/api";
import { requireCsrf, requireSession } from "@/server/auth/service";
import { setInstitutionAlias } from "@/server/domain/account-identity";
import { getDb } from "@/server/db/adapter";

export const runtime = "nodejs";

const schema = z.object({
  rawName: z.string().min(1).max(160),
  canonicalName: z.string().min(1).max(160),
});

export async function PUT(req: NextRequest) {
  return route(async (req) => {
    const session = await requireSession(req);
    requireCsrf(req);
    const body = await parseBody(schema, req);
    await setInstitutionAlias(getDb(), session.userId, body.rawName, body.canonicalName);
    return noContent();
  })(req, { params: Promise.resolve({}) });
}
