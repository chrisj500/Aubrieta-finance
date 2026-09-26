import { NextRequest } from "next/server";
import { apiErrors, ok, route } from "@/lib/api";
import { getDb } from "@/server/db/adapter";
import { createHouseholdService } from "@/server/domain/households";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  return route(async (req) => {
    const token = req.nextUrl.searchParams.get("token")?.trim();
    if (!token) throw apiErrors.badRequest("Invitation token is required.");
    const invitation = await createHouseholdService(getDb()).previewInvitation(token);
    return ok({ invitation });
  })(req, { params: Promise.resolve({}) });
}