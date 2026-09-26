import { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { requireSessionOrAgent, agentRoute } from "@/server/authz/agent-auth";
import { createInvestmentsService } from "@/server/domain/investments";
import { getDb } from "@/server/db/adapter";

export const runtime = "nodejs";

/** Investment accounts + holdings — user session or read:investments agent. */
export async function GET(req: NextRequest) {
  return agentRoute(async (req) => {
    const auth = await requireSessionOrAgent(req, ["read:investments"], "get_investments");
    const userId = auth.kind === "agent" ? auth.ctx.userId : auth.userId;
    const overview = await createInvestmentsService(getDb()).overview(userId);
    return ok(overview);
  })(req, { params: Promise.resolve({}) });
}
