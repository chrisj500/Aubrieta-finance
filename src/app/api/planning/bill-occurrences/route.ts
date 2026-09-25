import { NextRequest } from "next/server";
import { z } from "zod";
import { apiErrors, ok } from "@/lib/api";
import { requireSessionOrAgent, agentRoute } from "@/server/authz/agent-auth";
import { createBillIntelligenceService } from "@/server/domain/bill-intelligence";
import { addDaysISO, todayISO } from "@/server/domain/dates";
import { getDb } from "@/server/db/adapter";

export const runtime = "nodejs";

const querySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function GET(req: NextRequest) {
  return agentRoute(async (req) => {
    const auth = await requireSessionOrAgent(req, ["read:planning"], "get_planning_items");
    const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
    if (!parsed.success) {
      throw apiErrors.badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    }
    const userId = auth.kind === "agent" ? auth.ctx.userId : auth.userId;
    const from = parsed.data.from ?? addDaysISO(todayISO(), -31);
    const to = parsed.data.to ?? addDaysISO(todayISO(), 120);
    const intelligence = createBillIntelligenceService(getDb());
    await intelligence.ensureOccurrences(userId);
    await intelligence.matchPayments(userId);
    return ok({
      occurrences: await intelligence.listOccurrences(userId, from, to),
    });
  })(req, { params: Promise.resolve({}) });
}
