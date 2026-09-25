import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, parseBody, route } from "@/lib/api";
import { requireCsrf, requireSession } from "@/server/auth/service";
import { getDb } from "@/server/db/adapter";
import { createTellerService } from "@/server/teller/service";

export const runtime = "nodejs";

const schema = z.object({
  environment: z.enum(["sandbox", "development", "production"]),
  nonce: z.string().min(16),
  accessToken: z.string().min(1),
  tellerUserId: z.string().min(1),
  enrollmentId: z.string().min(1),
  institutionName: z.string().nullable().optional(),
  signatures: z.array(z.string().min(1)).min(1),
});

export async function POST(req: NextRequest) {
  return route(async (req) => {
    const session = await requireSession(req);
    requireCsrf(req);
    const body = await parseBody(schema, req);
    const result = await createTellerService(getDb()).acceptEnrollment(session.userId, {
      ...body,
      institutionName: body.institutionName ?? null,
    });
    return ok(result, { status: 201 });
  })(req, { params: Promise.resolve({}) });
}
