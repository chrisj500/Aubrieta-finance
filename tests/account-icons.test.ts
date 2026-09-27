import { describe, expect, it } from "vitest";
import { createTestDb, seedManualAccount, seedUser } from "./helpers";
import { createAccountIconService } from "@/server/domain/account-icons";

const PNG_DATA = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xj6uAAAAAElFTkSuQmCC";

describe("account artwork overrides", () => {
  it("stores, lists, replaces, and removes artwork for an owned account", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "account-icon-user");
    const accountId = await seedManualAccount(db, user.id, "Sapphire", "credit");
    const svc = createAccountIconService(db);

    const saved = await svc.set(user.id, accountId, PNG_DATA);
    expect(saved).toMatchObject({ accountId, mimeType: "image/png" });
    expect((await svc.list(user.id))).toHaveLength(1);

    await svc.set(user.id, accountId, PNG_DATA);
    expect((await svc.list(user.id))).toHaveLength(1);

    await svc.remove(user.id, accountId);
    expect(await svc.list(user.id)).toEqual([]);
  });

  it("does not let another user manage account artwork", async () => {
    const db = createTestDb();
    const owner = await seedUser(db, "art-owner");
    const other = await seedUser(db, "art-other");
    const accountId = await seedManualAccount(db, owner.id, "Private card", "credit");
    const svc = createAccountIconService(db);
    await expect(svc.set(other.id, accountId, PNG_DATA)).rejects.toThrow();
  });
});
