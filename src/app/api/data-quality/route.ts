import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api";
import { requireSession } from "@/server/auth/service";
import { createDataQualityService } from "@/server/domain/data-quality";
import { getDb } from "@/server/db/adapter";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  return route(async (req) => {
    const session = await requireSession(req);
    return ok(await createDataQualityService(getDb()).get(session.userId));
  })(req, { params: Promise.resolve({}) });
}
