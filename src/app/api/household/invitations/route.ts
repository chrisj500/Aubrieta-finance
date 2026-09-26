import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, parseBody, route } from "@/lib/api";
import { requireCsrf, requireSession } from "@/server/auth/service";
import { getDb } from "@/server/db/adapter";
import { createHouseholdService } from "@/server/domain/households";

export const runtime = "nodejs";

const schema = z.object({
  email: z.string().email().nullable().optional(),
});

export async function POST(req: NextRequest) {
  return route(async (req) => {
    const session = await requireSession(req);
    requireCsrf(req);
    const body = await parseBody(schema, req);
    const invitation = await createHouseholdService(getDb()).createInvitation(
      session.userId,
      body.email,
    );
    return ok({ invitation }, { status: 201 });
  })(req, { params: Promise.resolve({}) });
}