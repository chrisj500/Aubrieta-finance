import { describe, expect, it } from "vitest";
import { createTestDb } from "./helpers";
import { createSoloBootstrapService } from "@/server/domain/solo-bootstrap";
import { createNotificationsService } from "@/server/domain/notifications";

describe("notifications prefs (P11)", () => {
  it("defaults are safe and update persists", async () => {
    const db = createTestDb();
    const { user } = await createSoloBootstrapService(db).bootstrap({ displayName: "Phone", pin: "1234" });
    const svc = createNotificationsService(db);

    const d = await svc.get(user.id);
    expect(d.notifEnabled).toBe(false);
    expect(d.notifFrequency).toBe("weekly");
    expect(d.notifTime).toBe("09:00");
    expect(d.emailEnabled).toBe(false);
    expect(d.emailAddress).toBeNull();
    expect(d.biometricEnabled).toBe(false);
    expect(d.billRemindersEnabled).toBe(true);
    expect(d.billReminderDays).toEqual([7, 3, 1, 0]);

    const updated = await svc.update(user.id, {
      notifEnabled: true,
      notifFrequency: "daily",
      notifTime: "07:30",
      emailEnabled: true,
      emailAddress: "me@example.com",
      emailFrequency: "daily",
      biometricEnabled: true,
      billRemindersEnabled: true,
      billReminderDays: [0, 1, 7, 3, 3],
    });
    expect(updated.notifEnabled).toBe(true);
    expect(updated.notifFrequency).toBe("daily");
    expect(updated.notifTime).toBe("07:30");
    expect(updated.emailAddress).toBe("me@example.com");
    expect(updated.biometricEnabled).toBe(true);
    expect(updated.billRemindersEnabled).toBe(true);
    expect(updated.billReminderDays).toEqual([7, 3, 1, 0]);

    const reread = await svc.get(user.id);
    expect(reread).toEqual(updated);
  });

  it("partial updates leave other fields alone", async () => {
    const db = createTestDb();
    const { user } = await createSoloBootstrapService(db).bootstrap({ displayName: "Phone" });
    const svc = createNotificationsService(db);

    await svc.update(user.id, { notifEnabled: true });
    const p = await svc.get(user.id);
    expect(p.notifEnabled).toBe(true);
    expect(p.notifFrequency).toBe("weekly"); // untouched
    expect(p.emailEnabled).toBe(false); // untouched
  });

  it("normalizes bill reminder offsets and preserves them on partial updates", async () => {
    const db = createTestDb();
    const { user } = await createSoloBootstrapService(db).bootstrap({ displayName: "Phone" });
    const svc = createNotificationsService(db);

    const updated = await svc.update(user.id, {
      billRemindersEnabled: false,
      billReminderDays: [30, 7, 7, 1, -1, 31] as number[],
    });
    expect(updated.billRemindersEnabled).toBe(false);
    expect(updated.billReminderDays).toEqual([30, 7, 1]);

    const partial = await svc.update(user.id, { notifEnabled: true });
    expect(partial.billRemindersEnabled).toBe(false);
    expect(partial.billReminderDays).toEqual([30, 7, 1]);
  });

  it("invalid frequencies normalize to weekly", async () => {
    const db = createTestDb();
    const { user } = await createSoloBootstrapService(db).bootstrap({ displayName: "Phone" });
    const svc = createNotificationsService(db);
    const p = await svc.update(user.id, { notifFrequency: "hourly" as "daily" | "weekly" });
    expect(p.notifFrequency).toBe("weekly");
  });
});
