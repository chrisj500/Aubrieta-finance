import { NextRequest } from "next/server";
import { z } from "zod";
import { noContent, ok, parseBody, parseParam, route } from "@/lib/api";
import { requireCsrf, requireSession } from "@/server/auth/service";
import { clearCardIdentityOverride, setCardIdentityOverride } from "@/server/domain/account-identity";
import { createAccountsService } from "@/server/domain/accounts";
import { getDb } from "@/server/db/adapter";

export const runtime = "nodejs";

const schema = z.object({
  productKey: z.string().max(100).nullable().optional(),
  issuer: z.string().max(100).nullable().optional(),
  product: z.string().max(120).nullable().optional(),
  network: z.string().max(40).nullable().optional(),
});

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return route(async (req, ctx) => {
    const session = await requireSession(req);
    requireCsrf(req);
    const id = await parseParam(ctx, "id");
    const body = await parseBody(schema, req);
    const db = getDb();
    await setCardIdentityOverride(db, session.userId, id, body);
    const account = await createAccountsService(db).get(session.userId, id);
    return ok({ identity: account.card_identity ?? null });
  })(req, ctx);
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return route(async (req, ctx) => {
    const session = await requireSession(req);
    requireCsrf(req);
    const id = await parseParam(ctx, "id");
    const db = getDb();
    await clearCardIdentityOverride(db, session.userId, id);
    return noContent();
  })(req, ctx);
}
