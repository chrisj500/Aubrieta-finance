import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api";
import { requireSession, requireCsrf } from "@/server/auth/service";
import { createUpdatesService } from "@/server/domain/updates";
import { getDb } from "@/server/db/adapter";
import { isInstanceAdmin, requireInstanceAdmin } from "@/server/authz/instance-admin";

export const runtime = "nodejs";

/** Force a re-check against the release source (github-api or UPDATE_CHECK_URL). */
export async function POST(req: NextRequest) {
  return route(async (req) => {
    const session = await requireSession(req);
    requireCsrf(req);
    await requireInstanceAdmin(getDb(), session.userId);
    const svc = createUpdatesService(getDb());
    const found = await svc.check();
    const status = await svc.status();
    return ok({ found, status: { ...status, canManageUpdates: true } });
  })(req, { params: Promise.resolve({}) });
}

/** Current status without hitting the network (banner polls this). */
export async function GET(req: NextRequest) {
  return route(async (req) => {
    const session = await requireSession(req);
    const db = getDb();
    const status = await createUpdatesService(db).status();
    return ok({ ...status, canManageUpdates: await isInstanceAdmin(db, session.userId) });
  })(req, { params: Promise.resolve({}) });
}
