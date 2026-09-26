import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, parseBody, route } from "@/lib/api";
import { requireCsrf, requireSession } from "@/server/auth/service";
import { getDb } from "@/server/db/adapter";
import { createInstanceAdminService } from "@/server/domain/instance-admin";

export const runtime = "nodejs";

const createSchema = z.object({
  name: z.string().min(1).max(80),
  ownerEmail: z.string().email().nullable().optional(),
});

export async function GET(req: NextRequest) {
  return route(async (req) => {
    const session = await requireSession(req);
    const households = await createInstanceAdminService(getDb()).listHouseholds(session.userId);
    return ok({ households });
  })(req, { params: Promise.resolve({}) });
}

export async function POST(req: NextRequest) {
  return route(async (req) => {
    const session = await requireSession(req);
    requireCsrf(req);
    const body = await parseBody(createSchema, req);
    const result = await createInstanceAdminService(getDb()).provisionHousehold(session.userId, body);
    return ok(result, { status: 201 });
  })(req, { params: Promise.resolve({}) });
}
