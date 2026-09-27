import { NextRequest } from "next/server";
import { z } from "zod";
import { noContent, ok, parseBody, route } from "@/lib/api";
import { apiErrors } from "@/lib/api-error";
import { requireCsrf, requireSession } from "@/server/auth/service";
import { createInstitutionIconService } from "@/server/domain/institution-icons";
import { getDb } from "@/server/db/adapter";

export const runtime = "nodejs";

const putSchema = z.object({
  institutionName: z.string().min(1).max(160),
  dataUrl: z.string().min(1).max(400_000),
});

export async function GET(req: NextRequest) {
  return route(async (req) => {
    const session = await requireSession(req);
    return ok({ icons: await createInstitutionIconService(getDb()).list(session.userId) });
  })(req, { params: Promise.resolve({}) });
}

export async function PUT(req: NextRequest) {
  return route(async (req) => {
    const session = await requireSession(req);
    requireCsrf(req);
    const body = await parseBody(putSchema, req);
    return ok({ icon: await createInstitutionIconService(getDb()).set(session.userId, body.institutionName, body.dataUrl) });
  })(req, { params: Promise.resolve({}) });
}

export async function DELETE(req: NextRequest) {
  return route(async (req) => {
    const session = await requireSession(req);
    requireCsrf(req);
    const institutionName = new URL(req.url).searchParams.get("institutionName")?.trim();
    if (!institutionName) throw apiErrors.badRequest("institutionName is required.");
    await createInstitutionIconService(getDb()).remove(session.userId, institutionName);
    return noContent();
  })(req, { params: Promise.resolve({}) });
}
