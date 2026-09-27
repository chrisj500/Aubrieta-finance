import { describe, expect, it } from "vitest";
import { createTestDb, seedUser } from "./helpers";
import { createInstitutionIconService } from "@/server/domain/institution-icons";

// 1x1 transparent PNG.
const PNG_DATA = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xj6uAAAAAElFTkSuQmCC";

describe("institution icon overrides", () => {
  it("stores, lists, replaces, and removes a user-scoped icon", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "icon-user");
    const svc = createInstitutionIconService(db);

    const saved = await svc.set(user.id, "Chase Bank", PNG_DATA);
    expect(saved).toMatchObject({ institutionKey: "chasebank", institutionName: "Chase Bank", mimeType: "image/png" });
    expect((await svc.list(user.id))).toHaveLength(1);

    const replaced = await svc.set(user.id, "Chase Bank", PNG_DATA);
    expect(replaced.institutionKey).toBe("chasebank");
    expect((await svc.list(user.id))).toHaveLength(1);

    await svc.remove(user.id, "Chase Bank");
    expect(await svc.list(user.id)).toEqual([]);
  });

  it("rejects unsupported or spoofed image data", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "icon-invalid");
    const svc = createInstitutionIconService(db);
    await expect(svc.set(user.id, "Bank", "data:image/svg+xml;base64,PHN2Zz4=")).rejects.toThrow(/PNG, JPEG, or WebP/);
    await expect(svc.set(user.id, "Bank", "data:image/png;base64,SGVsbG8=")).rejects.toThrow(/contents/);
  });
});
