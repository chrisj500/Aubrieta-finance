import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api";
import { requireSession } from "@/server/auth/service";
import { getDb } from "@/server/db/adapter";
import { isInstanceAdmin } from "@/server/authz/instance-admin";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  return route(async (req) => {
    const session = await requireSession(req);
    return ok({ isInstanceAdmin: await isInstanceAdmin(getDb(), session.userId) });
  })(req, { params: Promise.resolve({}) });
}
