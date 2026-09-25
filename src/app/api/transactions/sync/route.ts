import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api";
import { requireCsrf, requireSession } from "@/server/auth/service";
import { createSyncService } from "@/server/plaid/sync";
import { createTellerService } from "@/server/teller/service";
import { createSimpleFinService } from "@/server/simplefin/service";
import { getDb } from "@/server/db/adapter";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  return route(async (req) => {
    const session = await requireSession(req);
    requireCsrf(req);
    const db = getDb();
    const [plaid, teller, simplefin] = await Promise.all([
      createSyncService(db).syncAll(session.userId),
      createTellerService(db).syncAll(session.userId),
      createSimpleFinService(db).syncAll(session.userId),
    ]);
    const results = [
      ...plaid.map((r) => ({ ...r, provider: "plaid" as const })),
      ...teller,
      ...simplefin,
    ];
    return ok({ results });
  })(req, { params: Promise.resolve({}) });
}
