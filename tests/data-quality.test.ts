import { describe, expect, it } from "vitest";
import { createTestDb, seedManualAccount, seedUser } from "./helpers";
import { createDataQualityService } from "@/server/domain/data-quality";

describe("data-quality audit", () => {
  it("reports normalization, identity confidence, metadata gaps, history coverage, and duplicate candidates", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "data-quality");
    const now = new Date().toISOString();
    const a = await seedManualAccount(db, user.id, "Chase Sapphire Preferred (1234)", "credit");
    const b = await seedManualAccount(db, user.id, "Mystery Card", "credit");
    const c = await seedManualAccount(db, user.id, "Duplicate Card", "credit");
    const embeddedMask = await seedManualAccount(db, user.id, "Named Card (5555)", "credit");
    await seedManualAccount(db, user.id, "Unknown Credit Union Card", "credit");
    await db.run("UPDATE accounts SET mask = '1234' WHERE id IN (?, ?)", a, c);

    await db.run(
      `INSERT INTO provider_connections (id,user_id,provider,external_connection_id,institution_name,status,capabilities_json,created_at,updated_at,environment,last_sync_at,last_error)
       VALUES ('conn-1',?,'simplefin','conn-1','JPMorgan Chase Bank, N.A.','active','[\"accounts\",\"transactions\"]',?,?, 'production',?,NULL)`,
      user.id, now, now, now,
    );
    for (const [id, ext] of [[a, 'acct-a'], [b, 'acct-b'], [c, 'acct-c'], [embeddedMask, 'acct-mask']] as const) {
      await db.run(
        `INSERT INTO account_provider_refs (id,user_id,account_id,connection_id,provider,external_account_id,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        `ref-${ext}`, user.id, id, 'conn-1', 'simplefin', ext, now, now,
      );
    }
    const txId = 'tx-quality';
    await db.run(
      `INSERT INTO transactions (id,account_id,amount_cents,date,name,pending,source,created_at)
       VALUES (?,?,-1250,'2026-09-01','TEST',0,'simplefin',?)`,
      txId, a, now,
    );
    await db.run(
      `INSERT INTO transaction_provider_refs (id,user_id,transaction_id,account_id,connection_id,provider,external_transaction_id,created_at,updated_at)
       VALUES ('tpr-quality',?,?,?,?,?,?,?,?)`,
      user.id, txId, a, 'conn-1', 'simplefin', 'ext-tx-quality', now, now,
    );

    const result = await createDataQualityService(db).get(user.id);
    expect(result.summary.accountCount).toBe(5);
    expect(result.summary.rawInstitutionCount).toBe(1);
    expect(result.summary.canonicalInstitutionCount).toBe(1);
    expect(result.institutionNormalizations).toContainEqual({ rawName: 'JPMorgan Chase Bank, N.A.', canonicalName: 'Chase Bank', accountCount: 4 });
    expect(result.summary.exactIdentityCount).toBeGreaterThanOrEqual(1);
    expect(result.summary.genericIdentityCount).toBeGreaterThanOrEqual(1);
    expect(result.summary.potentialDuplicateCount).toBe(1);
    expect(result.metadataGaps.find((gap) => gap.name === "Named Card (5555)" && gap.reasons.includes("Missing card last four"))).toBeUndefined();
    expect(result.history[0]).toMatchObject({ provider: 'simplefin', transactionCount: 1, oldestDate: '2026-09-01', newestDate: '2026-09-01' });
    expect(result.integrity).toEqual({ orphanedAccountProviderRefs: 0, missingConnectionRefs: 0 });
  });
});
