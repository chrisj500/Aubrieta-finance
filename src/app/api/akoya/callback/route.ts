import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/server/auth/service";
import { getDb } from "@/server/db/adapter";
import { createAkoyaService } from "@/server/akoya/service";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const settings = new URL("/settings", req.url);
  try {
    const session = await requireSession(req);
    const url = new URL(req.url);
    const error = url.searchParams.get("error");
    if (error) throw new Error("Akoya authorization was not completed.");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) throw new Error("Akoya callback is missing authorization data.");

    const result = await createAkoyaService(getDb()).completeAuthorization(
      session.userId,
      state,
      code,
    );
    settings.searchParams.set("akoya", result.sync.ok ? "connected" : "connected_sync_error");
  } catch {
    settings.searchParams.set("akoya", "error");
  }
  return NextResponse.redirect(settings);
}
