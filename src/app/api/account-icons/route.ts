import { NextRequest } from "next/server";
import { z } from "zod";
import { noContent, ok, parseBody, route } from "@/lib/api";
import { apiErrors } from "@/lib/api-error";
import { requireCsrf, requireSession } from "@/server/auth/service";
import { createAccountIconService } from "@/server/domain/account-icons";
import { getDb } from "@/server/db/adapter";

export const runtime = "nodejs";

const putSchema = z.object({
  accountId: z.string().min(1).max(100),
  dataUrl: z.string().min(1).max(400_000),
});

export async function GET(req: NextRequest) {
  return route(async (req) => {
    const session = await requireSession(req);
    return ok({ icons: await createAccountIconService(getDb()).list(session.userId) });
  })(req, { params: Promise.resolve({}) });
}

export async function PUT(req: NextRequest) {
  return route(async (req) => {
    const session = await requireSession(req);
    requireCsrf(req);
    const body = await parseBody(putSchema, req);
    return ok({ icon: await createAccountIconService(getDb()).set(session.userId, body.accountId, body.dataUrl) });
  })(req, { params: Promise.resolve({}) });
}

export async function DELETE(req: NextRequest) {
  return route(async (req) => {
    const session = await requireSession(req);
    requireCsrf(req);
    const accountId = new URL(req.url).searchParams.get("accountId")?.trim();
    if (!accountId) throw apiErrors.badRequest("accountId is required.");
    await createAccountIconService(getDb()).remove(session.userId, accountId);
    return noContent();
  })(req, { params: Promise.resolve({}) });
}
