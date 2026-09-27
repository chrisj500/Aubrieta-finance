import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api";
import { requireSession } from "@/server/auth/service";
import { listCardProducts } from "@/server/domain/account-identity";
import { getDb } from "@/server/db/adapter";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  return route(async (req) => {
    await requireSession(req);
    return ok({ products: await listCardProducts(getDb()) });
  })(req, { params: Promise.resolve({}) });
}
