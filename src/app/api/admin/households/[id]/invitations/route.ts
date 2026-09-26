import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, parseBody, route } from "@/lib/api";
import { requireCsrf, requireSession } from "@/server/auth/service";
import { getDb } from "@/server/db/adapter";
import { createInstanceAdminService } from "@/server/domain/instance-admin";

export const runtime = "nodejs";

const schema = z.object({
  ownerEmail: z.string().email().nullable().optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return route(async (req, ctx) => {
    const session = await requireSession(req);
    requireCsrf(req);
    const { id } = await ctx.params;
    const body = await parseBody(schema, req);
    const invitation = await createInstanceAdminService(getDb()).createOwnerInvitation(
      session.userId,
      id,
      body.ownerEmail,
    );
    return ok({ invitation }, { status: 201 });
  })(req, ctx);
}
