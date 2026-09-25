import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api";
import { requireCsrf, requireSession } from "@/server/auth/service";
import { createBillIntelligenceService } from "@/server/domain/bill-intelligence";
import { getDb } from "@/server/db/adapter";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  return route(async (req) => {
    const session = await requireSession(req);
    requireCsrf(req);
    const result = await createBillIntelligenceService(getDb()).refresh(session.userId);
    return ok(result);
  })(req, { params: Promise.resolve({}) });
}
