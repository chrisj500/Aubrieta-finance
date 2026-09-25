import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api";
import { requireCsrf, requireSession } from "@/server/auth/service";
import { createSyncService } from "@/server/plaid/sync";
import { createTellerService } from "@/server/teller/service";
import { createSimpleFinService } from "@/server/simplefin/service";
import { createAkoyaService } from "@/server/akoya/service";
import { getDb } from "@/server/db/adapter";
import { createBillIntelligenceService } from "@/server/domain/bill-intelligence";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  return route(async (req) => {
    const session = await requireSession(req);
    requireCsrf(req);
    const db = getDb();
    const [plaid, teller, simplefin, akoya] = await Promise.all([
      createSyncService(db).syncAll(session.userId),
      createTellerService(db).syncAll(session.userId),
      createSimpleFinService(db).syncAll(session.userId),
      createAkoyaService(db).syncAll(session.userId, "USER"),
    ]);
    const results = [
      ...plaid.map((r) => ({ ...r, provider: "plaid" as const })),
      ...teller,
      ...simplefin,
      ...akoya,
    ];
    const bills = await createBillIntelligenceService(db).refresh(session.userId);
    return ok({ results, bills });
  })(req, { params: Promise.resolve({}) });
}
