import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api";
import { requireSession } from "@/server/auth/service";
import { getDb } from "@/server/db/adapter";
import { createTellerService } from "@/server/teller/service";
import type { TellerEnvironment } from "@/server/providers/teller";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  return route(async (req) => {
    const session = await requireSession(req);
    const url = new URL(req.url);
    const raw = url.searchParams.get("environment") ?? "sandbox";
    if (!["sandbox", "development", "production"].includes(raw)) {
      throw new Error("Invalid Teller environment.");
    }
    const enrollmentId = url.searchParams.get("enrollmentId") ?? undefined;
    return ok(await createTellerService(getDb()).createConnectConfig(
      session.userId,
      raw as TellerEnvironment,
      enrollmentId,
    ));
  })(req, { params: Promise.resolve({}) });
}
