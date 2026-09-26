import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api";
import { requireSession } from "@/server/auth/service";
import { getDb } from "@/server/db/adapter";
import { createConnectionHealthService } from "@/server/domain/connection-health";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  return route(async (req) => {
    const session = await requireSession(req);
    return ok(await createConnectionHealthService(getDb()).get(session.userId));
  })(req, { params: Promise.resolve({}) });
}
