import { NextRequest } from "next/server";
import { z } from "zod";
import { apiErrors, ok, parseBody, route } from "@/lib/api";
import { requireSession } from "@/server/auth/service";
import { agentRoute, bearerToken } from "@/server/authz/agent-auth";
import { createAgentTokenService } from "@/server/authz/tokens";
import { createAgentManualService } from "@/server/domain/agent-manual";
import { MANUAL_MAX_LEN } from "@/server/domain/agent-manual-meta";
import { getDb } from "@/server/db/adapter";

export const runtime = "nodejs";

const schema = z.object({
  categorization: z.string().max(MANUAL_MAX_LEN).optional(),
  budgeting: z.string().max(MANUAL_MAX_LEN).optional(),
  general: z.string().max(MANUAL_MAX_LEN).optional(),
});

async function readManual(userId: string, req: NextRequest) {
  const manual = await createAgentManualService(getDb()).get(userId);
  // ?since=<version> — cheap change check: unchanged → changed:false, no text.
  const sinceRaw = req.nextUrl.searchParams.get("since");
  const since = sinceRaw !== null && !Number.isNaN(Number(sinceRaw)) ? Number(sinceRaw) : undefined;
  if (since !== undefined && since === manual.version) {
    return ok({ changed: false, version: manual.version });
  }
  return ok({ changed: true, version: manual.version, manual });
}

/**
 * GET /api/agent/manual — the user's live AI steering manual (D11).
 *
 * Agents read with a Bearer token on every poll. The human-facing Agents page
 * reads the same resource with the user's session cookie, so the editor does
 * not need a second endpoint and a scope-free agent 401 cannot be mistaken for
 * an expired user session by the shared API client.
 */
export async function GET(req: NextRequest) {
  const raw = bearerToken(req);
  if (!raw) {
    return route(async (req) => {
      const session = await requireSession(req);
      return readManual(session.userId, req);
    })(req, { params: Promise.resolve({}) });
  }

  return agentRoute(async (req) => {
    const token = await createAgentTokenService(getDb()).authenticate(raw);
    if (!token) throw apiErrors.unauthorized();
    return readManual(token.user_id, req);
  })(req, { params: Promise.resolve({}) });
}

/** PUT /api/agent/manual — user edits their AI steering guidance (user session only). */
export const PUT = route(async (req: NextRequest) => {
  const session = await requireSession(req);
  const body = await parseBody(schema, req);
  const manual = await createAgentManualService(getDb()).update(session.userId, body);
  return ok({ manual });
});
