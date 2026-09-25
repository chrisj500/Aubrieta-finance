import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, parseBody, parseParam, route } from "@/lib/api";
import { requireCsrf, requireSession } from "@/server/auth/service";
import { createBillIntelligenceService } from "@/server/domain/bill-intelligence";
import { MAX_AMOUNT_CENTS } from "@/server/domain/money";
import { getDb } from "@/server/db/adapter";

export const runtime = "nodejs";

const schema = z.object({
  amountCents: z
    .number()
    .int()
    .positive()
    .max(MAX_AMOUNT_CENTS)
    .optional(),
});

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) {
  return route(async (req, ctx) => {
    const session = await requireSession(req);
    requireCsrf(req);
    const id = await parseParam(ctx, "id");
    const body = await parseBody(schema, req);
    await createBillIntelligenceService(getDb()).markOccurrencePaid(
      session.userId,
      id,
      body.amountCents,
    );
    return ok({ paid: true });
  })(req, ctx);
}
