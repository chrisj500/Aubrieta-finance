import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, parseBody, route } from "@/lib/api";
import { requireCsrf, requireSession } from "@/server/auth/service";
import { getDb } from "@/server/db/adapter";
import { createTellerService } from "@/server/teller/service";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  return route(async (req) => {
    const session = await requireSession(req);
    return ok(await createTellerService(getDb()).listCredentialStatus(session.userId));
  })(req, { params: Promise.resolve({}) });
}

const schema = z.object({
  environment: z.enum(["sandbox", "development", "production"]),
  applicationId: z.string().min(1),
  certificatePem: z.string().nullable().optional(),
  privateKeyPem: z.string().nullable().optional(),
  tokenSigningKey: z.string().min(1),
});

export async function PUT(req: NextRequest) {
  return route(async (req) => {
    const session = await requireSession(req);
    requireCsrf(req);
    const body = await parseBody(schema, req);
    return ok(await createTellerService(getDb()).saveCredentials(session.userId, body));
  })(req, { params: Promise.resolve({}) });
}
