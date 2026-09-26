import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api";
import { requireCsrf, requireSession } from "@/server/auth/service";
import { createSyncService } from "@/server/plaid/sync";
import { createTellerService } from "@/server/teller/service";
import { createSimpleFinService } from "@/server/simplefin/service";
import { createAkoyaService } from "@/server/akoya/service";
import { getDb } from "@/server/db/adapter";
import { createBillIntelligenceService } from "@/server/domain/bill-intelligence";
import { isolateProviderBatch } from "@/server/providers/batch-isolation";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  return route(async (req) => {
    const session = await requireSession(req);
    requireCsrf(req);
    const db = getDb();
    const [plaid, teller, simplefin, akoya] = await Promise.all([
      isolateProviderBatch(
        "plaid",
        () => createSyncService(db).syncAll(session.userId),
        (error) => ({
          itemId: "plaid:provider-batch",
          institutionName: null,
          added: 0,
          modified: 0,
          removed: 0,
          ok: false,
          error,
        }),
      ),
      isolateProviderBatch(
        "teller",
        () => createTellerService(db).syncAll(session.userId),
        (error) => ({
          connectionId: "teller:provider-batch",
          provider: "teller" as const,
          institutionName: null,
          added: 0,
          modified: 0,
          removed: 0,
          ok: false,
          error,
        }),
      ),
      isolateProviderBatch(
        "simplefin",
        () => createSimpleFinService(db).syncAll(session.userId),
        (error) => ({
          connectionId: "simplefin:provider-batch",
          provider: "simplefin" as const,
          institutionName: null,
          added: 0,
          modified: 0,
          removed: 0,
          ok: false,
          error,
        }),
      ),
      isolateProviderBatch(
        "akoya",
        () => createAkoyaService(db).syncAll(session.userId, "USER"),
        (error) => ({
          connectionId: "akoya:provider-batch",
          provider: "akoya" as const,
          institutionName: null,
          added: 0,
          modified: 0,
          removed: 0,
          ok: false,
          error,
        }),
      ),
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
