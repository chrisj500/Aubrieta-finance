import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET, PUT } from "@/app/api/agent/manual/route";
import { createSession } from "@/server/auth/sessions";
import { createAgentTokenService } from "@/server/authz/tokens";
import { createAgentManualService } from "@/server/domain/agent-manual";
import { getSqliteDb, type Db } from "@/server/db/adapter";
import { seedUser } from "./helpers";

async function setup(): Promise<{ db: Db; userId: string; cookie: string; bearer: string }> {
  const db = getSqliteDb();
  const migrated = await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='users'");
  if (!migrated) {
    const files = fs
      .readdirSync(path.join(process.cwd(), "migrations"))
      .filter((f) => /^\d+_.*\.sql$/.test(f))
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    for (const file of files) {
      getSqliteDb().exec(fs.readFileSync(path.join(process.cwd(), "migrations", file), "utf8"));
    }
  }

  const user = await seedUser(db, `manual-route-${randomUUID()}`);
  await createAgentManualService(db).update(user.id, {
    categorization: "Prefer the user's explicit category overrides.",
    general: "Keep responses concise.",
  });
  const session = await createSession(user.id, "1h", "manual-route-test", db);
  const agent = await createAgentTokenService(db).create(user.id, { name: "manual-reader", preset: "read-only" });
  return { db, userId: user.id, cookie: `of_session=${session.token}`, bearer: agent.token };
}

describe("agent manual GET dual authentication", () => {
  it("lets the signed-in human editor read its own manual", async () => {
    const { cookie } = await setup();
    const res = await GET(new NextRequest("http://localhost/api/agent/manual", { headers: { cookie } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changed: boolean; manual: { categorization: string; general: string } };
    expect(body.changed).toBe(true);
    expect(body.manual.categorization).toContain("explicit category overrides");
    expect(body.manual.general).toBe("Keep responses concise.");
  });

  it("preserves the scope-free Bearer-token polling contract", async () => {
    const { bearer } = await setup();
    const res = await GET(
      new NextRequest("http://localhost/api/agent/manual?since=0", {
        headers: { authorization: `Bearer ${bearer}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changed: boolean; version: number; manual?: { categorization: string } };
    expect(body.changed).toBe(true);
    expect(body.version).toBeGreaterThan(0);
    expect(body.manual?.categorization).toContain("explicit category overrides");
  });

  it("still rejects a request with neither a session nor a Bearer token", async () => {
    const res = await GET(new NextRequest("http://localhost/api/agent/manual"));
    expect(res.status).toBe(401);
  });
});

describe("agent manual PUT CSRF", () => {
  it("rejects a session-cookie mutation without x-of-request and preserves the manual", async () => {
    const { db, userId, cookie } = await setup();
    const before = await createAgentManualService(db).get(userId);
    const res = await PUT(new NextRequest("http://localhost/api/agent/manual", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ general: "Cross-site overwrite" }),
    }), { params: Promise.resolve({}) });
    expect(res.status).toBe(403);
    const after = await createAgentManualService(db).get(userId);
    expect(after.general).toBe(before.general);
  });

  it("still lets the signed-in human update the manual with the CSRF marker", async () => {
    const { cookie } = await setup();
    const res = await PUT(new NextRequest("http://localhost/api/agent/manual", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json", "x-of-request": "1" },
      body: JSON.stringify({ general: "Updated by the signed-in user." }),
    }), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { manual: { general: string } };
    expect(body.manual.general).toBe("Updated by the signed-in user.");
  });
});
