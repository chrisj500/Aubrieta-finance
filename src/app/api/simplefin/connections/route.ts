import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api";
import { requireSession } from "@/server/auth/service";
import { getDb } from "@/server/db/adapter";
import { createSimpleFinService } from "@/server/simplefin/service";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  return route(async (req) => {
    const session = await requireSession(req);
    return ok(await createSimpleFinService(getDb()).listConnections(session.userId));
  })(req, { params: Promise.resolve({}) });
}
