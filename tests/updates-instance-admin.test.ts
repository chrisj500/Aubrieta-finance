import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getDb, getSqliteDb } from "@/server/db/adapter";
import { createSession } from "@/server/auth/sessions";
import { seedUser } from "./helpers";
import { GET as updatesGet, POST as updatesPost } from "@/app/api/updates/route";
import { POST as decidePost } from "@/app/api/updates/decide/route";

const BASE = "http://localhost:3000";

function migrateSingleton(): void {
  const db = getSqliteDb();
  const files = fs
    .readdirSync(path.join(process.cwd(), "migrations"))
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  for (const file of files) db.exec(fs.readFileSync(path.join(process.cwd(), "migrations", file), "utf8"));
}

beforeAll(async () => {
  const db = getSqliteDb();
  const users = await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='users'");
  if (!users) migrateSingleton();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.UPDATE_SCRIPT;
});

async function sessionFor(admin: boolean): Promise<string> {
  const db = getDb();
  const user = await seedUser(db, `updates-${admin ? "admin" : "member"}-${randomUUID().slice(0, 8)}`);
  if (admin) {
    await db.run(
      "INSERT INTO instance_admins (user_id, created_at, created_by_user_id) VALUES (?, ?, ?)",
      user.id,
      new Date().toISOString(),
      user.id,
    );
  }
  const { token } = await createSession(user.id, "1h", "updates-authz-test", db);
  return `of_session=${token}`;
}

function request(pathname: string, cookie: string, body?: unknown): NextRequest {
  return new NextRequest(`${BASE}${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie,
      ...(body === undefined ? {} : { "content-type": "application/json", "x-of-request": "1" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("instance-level update authorization", () => {
  it("reports update-management capability without hiding status from household users", async () => {
    const memberCookie = await sessionFor(false);
    const adminCookie = await sessionFor(true);

    const member = await updatesGet(request("/api/updates", memberCookie));
    expect(member.status).toBe(200);
    expect(await member.json()).toMatchObject({ canManageUpdates: false });

    const admin = await updatesGet(request("/api/updates", adminCookie));
    expect(admin.status).toBe(200);
    expect(await admin.json()).toMatchObject({ canManageUpdates: true });
  });

  it("blocks a normal household user before the release check can make a network request", async () => {
    const cookie = await sessionFor(false);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await updatesPost(request("/api/updates", cookie, {}));
    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("blocks a normal household user from triggering the host update script", async () => {
    const cookie = await sessionFor(false);
    process.env.UPDATE_SCRIPT = "/definitely/does-not-exist/aubrieta-update";

    const res = await decidePost(request("/api/updates/decide", cookie, { action: "now" }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/instance administrator/i);
  });

  it("keeps safe update-management actions available to the instance administrator", async () => {
    const cookie = await sessionFor(true);
    const res = await decidePost(request("/api/updates/decide", cookie, { action: "cancel" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ cancelled: true });
  });
});
