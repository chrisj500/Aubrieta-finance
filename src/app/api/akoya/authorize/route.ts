import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, parseBody, route } from "@/lib/api";
import { requireCsrf, requireSession } from "@/server/auth/service";
import { getDb } from "@/server/db/adapter";
import { createAkoyaService } from "@/server/akoya/service";

export const runtime = "nodejs";

const schema = z.object({
  environment: z.enum(["sandbox", "production"]),
  providerId: z.string().min(1).max(120),
});

export async function POST(req: NextRequest) {
  return route(async (req) => {
    const session = await requireSession(req);
    requireCsrf(req);
    const body = await parseBody(schema, req);
    return ok(
      await createAkoyaService(getDb()).startAuthorization(
        session.userId,
        body.environment,
        body.providerId,
      ),
    );
  })(req, { params: Promise.resolve({}) });
}
