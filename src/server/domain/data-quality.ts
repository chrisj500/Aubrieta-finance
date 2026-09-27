import type { Db } from "@/server/db/types";
import { createInstitutionNormalizer, resolveCardIdentities } from "@/server/domain/account-identity";

interface AuditAccountRow {
  id: string;
  name: string;
  official_name: string | null;
  type: string | null;
  mask: string | null;
  institution_raw_name: string | null;
  provider_ref_count: number;
}

export interface DataQualityResult {
  summary: {
    accountCount: number;
    providerAccountCount: number;
    manualAccountCount: number;
    rawInstitutionCount: number;
    canonicalInstitutionCount: number;
    normalizedAliasCount: number;
    potentialDuplicateCount: number;
    metadataGapCount: number;
    creditCardCount: number;
    exactIdentityCount: number;
    likelyIdentityCount: number;
    genericIdentityCount: number;
    identityOverrideCount: number;
    connectionCount: number;
    connectionIssueCount: number;
    oldestTransactionDate: string | null;
    newestTransactionDate: string | null;
  };
  institutionNormalizations: Array<{ rawName: string; canonicalName: string; accountCount: number }>;
  genericCards: Array<{ id: string; name: string; institutionName: string | null; mask: string | null }>;
  metadataGaps: Array<{ id: string; name: string; reasons: string[] }>;
  duplicateCandidates: Array<{ institutionName: string; mask: string; type: string; accountNames: string[] }>;
  history: Array<{
    connectionId: string;
    provider: string;
    institutionName: string;
    transactionCount: number;
    oldestDate: string | null;
    newestDate: string | null;
    lastSyncAt: string | null;
    lastError: string | null;
  }>;
  integrity: {
    orphanedAccountProviderRefs: number;
    missingConnectionRefs: number;
  };
}


function effectiveMask(row: Pick<AuditAccountRow, "mask" | "name" | "official_name">): string | null {
  const direct = row.mask?.trim();
  if (direct) return direct;
  for (const value of [row.name, row.official_name]) {
    const match = value?.match(/(?:\(|\b)(\d{4})\)?\s*$/);
    if (match) return match[1];
  }
  return null;
}


function duplicateNameKey(row: Pick<AuditAccountRow, "name" | "official_name">): string {
  const value = (row.official_name?.trim() || row.name.trim())
    .replace(/(?:\(|\b)\d{4}\)?\s*$/, "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
  return value;
}

function isHealthyStatus(status: string): boolean {
  return status === "active" || status === "linked";
}

export function createDataQualityService(db: Db) {
  return {
    async get(userId: string): Promise<DataQualityResult> {
      const rows = await db.all<AuditAccountRow>(
        `SELECT a.id, a.name, a.official_name, a.type, a.mask,
                COALESCE(
                  i.institution_name,
                  (SELECT pc.institution_name
                     FROM account_provider_refs apr2
                     JOIN provider_connections pc ON pc.id = apr2.connection_id
                    WHERE apr2.account_id = a.id
                    ORDER BY CASE apr2.provider WHEN 'plaid' THEN 0 WHEN 'simplefin' THEN 1 WHEN 'akoya' THEN 2 ELSE 3 END
                    LIMIT 1)
                ) AS institution_raw_name,
                (SELECT COUNT(*) FROM account_provider_refs apr3 WHERE apr3.account_id = a.id) AS provider_ref_count
           FROM accounts a
           LEFT JOIN plaid_items i ON i.id = a.item_id
          WHERE COALESCE(a.owner_user_id, a.user_id) = ?
            AND a.deleted_at IS NULL
            AND a.hidden = 0`,
        userId,
      );

      const normalizeInstitution = await createInstitutionNormalizer(db, userId);
      const normalizedAccounts = rows.map((row) => ({
        ...row,
        institution_name: normalizeInstitution(row.institution_raw_name),
      }));
      const identities = await resolveCardIdentities(db, userId, normalizedAccounts);

      const rawInstitutionNames = new Set(rows.map((row) => row.institution_raw_name?.trim()).filter((value): value is string => Boolean(value)));
      const canonicalInstitutionNames = new Set(normalizedAccounts.map((row) => row.institution_name).filter((value): value is string => Boolean(value)));
      const normalizationCounts = new Map<string, { rawName: string; canonicalName: string; accountCount: number }>();
      for (const row of normalizedAccounts) {
        const raw = row.institution_raw_name?.trim();
        const canonical = row.institution_name?.trim();
        if (!raw || !canonical || raw === canonical) continue;
        const key = `${raw}\u0000${canonical}`;
        const existing = normalizationCounts.get(key);
        normalizationCounts.set(key, { rawName: raw, canonicalName: canonical, accountCount: (existing?.accountCount ?? 0) + 1 });
      }

      const metadataGaps = normalizedAccounts.flatMap((row) => {
        if (row.provider_ref_count === 0) return [];
        const reasons: string[] = [];
        if (!row.institution_name) reasons.push("Missing institution");
        if (!row.type || row.type === "other") reasons.push("Generic account type");
        if (row.type === "credit" && !effectiveMask(row)) reasons.push("Missing card last four");
        return reasons.length ? [{ id: row.id, name: row.name, reasons }] : [];
      });

      const duplicateGroups = new Map<string, { institutionName: string; mask: string; type: string; accountNames: string[] }>();
      for (const row of normalizedAccounts) {
        const mask = effectiveMask(row);
        if (!mask || !row.institution_name) continue;
        const type = row.type ?? "other";
        const nameKey = duplicateNameKey(row);
        if (!nameKey) continue;
        const key = `${row.institution_name.toLowerCase()}\u0000${mask}\u0000${type}\u0000${nameKey}`;
        const existing = duplicateGroups.get(key) ?? { institutionName: row.institution_name, mask, type, accountNames: [] };
        existing.accountNames.push(row.name);
        duplicateGroups.set(key, existing);
      }
      const duplicateCandidates = [...duplicateGroups.values()].filter((group) => group.accountNames.length > 1);

      const creditRows = normalizedAccounts.filter((row) => row.type === "credit");
      const resolvedCredit = creditRows.map((row) => ({ row, identity: identities.get(row.id) })).filter((item) => Boolean(item.identity));
      const genericCards = resolvedCredit
        .filter((item) => item.identity?.confidence === "generic")
        .slice(0, 25)
        .map((item) => ({
          id: item.row.id,
          name: item.row.name,
          institutionName: item.row.institution_name,
          mask: effectiveMask(item.row),
        }));

      const historyRows = await db.all<{
        connection_id: string;
        provider: string;
        institution_name: string | null;
        status: string;
        last_sync_at: string | null;
        last_error: string | null;
        transaction_count: number;
        oldest_date: string | null;
        newest_date: string | null;
      }>(
        `SELECT pc.id AS connection_id,
                pc.provider,
                pc.institution_name,
                pc.status,
                pc.last_sync_at,
                pc.last_error,
                COUNT(DISTINCT tpr.transaction_id) AS transaction_count,
                MIN(t.date) AS oldest_date,
                MAX(t.date) AS newest_date
           FROM provider_connections pc
           LEFT JOIN transaction_provider_refs tpr ON tpr.connection_id = pc.id
           LEFT JOIN transactions t ON t.id = tpr.transaction_id
          WHERE pc.user_id = ?
          GROUP BY pc.id, pc.provider, pc.institution_name, pc.status, pc.last_sync_at, pc.last_error
          ORDER BY pc.provider, pc.institution_name COLLATE NOCASE`,
        userId,
      );
      const history = historyRows.map((row) => ({
        connectionId: row.connection_id,
        provider: row.provider,
        institutionName: row.institution_name?.trim() || `${row.provider} connection`,
        transactionCount: Number(row.transaction_count ?? 0),
        oldestDate: row.oldest_date,
        newestDate: row.newest_date,
        lastSyncAt: row.last_sync_at,
        lastError: row.last_error?.trim() || null,
      }));

      const [orphaned, missingConnection, overrideCount] = await Promise.all([
        db.get<{ c: number }>(
          `SELECT COUNT(*) AS c
             FROM account_provider_refs apr
             LEFT JOIN accounts a ON a.id = apr.account_id
            WHERE apr.user_id = ? AND a.id IS NULL`,
          userId,
        ),
        db.get<{ c: number }>(
          `SELECT COUNT(*) AS c
             FROM account_provider_refs apr
             LEFT JOIN provider_connections pc ON pc.id = apr.connection_id
            WHERE apr.user_id = ? AND pc.id IS NULL`,
          userId,
        ),
        db.get<{ c: number }>("SELECT COUNT(*) AS c FROM account_card_identity_overrides WHERE user_id = ?", userId),
      ]);

      const transactionDates = history.flatMap((row) => [row.oldestDate, row.newestDate]).filter((value): value is string => Boolean(value)).sort();
      const exactIdentityCount = resolvedCredit.filter((item) => item.identity?.confidence === "exact").length;
      const likelyIdentityCount = resolvedCredit.filter((item) => item.identity?.confidence === "likely").length;
      const genericIdentityCount = resolvedCredit.filter((item) => item.identity?.confidence === "generic").length;

      return {
        summary: {
          accountCount: rows.length,
          providerAccountCount: rows.filter((row) => row.provider_ref_count > 0).length,
          manualAccountCount: rows.filter((row) => row.provider_ref_count === 0).length,
          rawInstitutionCount: rawInstitutionNames.size,
          canonicalInstitutionCount: canonicalInstitutionNames.size,
          normalizedAliasCount: [...normalizationCounts.values()].reduce((sum, item) => sum + item.accountCount, 0),
          potentialDuplicateCount: duplicateCandidates.length,
          metadataGapCount: metadataGaps.length,
          creditCardCount: creditRows.length,
          exactIdentityCount,
          likelyIdentityCount,
          genericIdentityCount,
          identityOverrideCount: overrideCount?.c ?? 0,
          connectionCount: historyRows.length,
          connectionIssueCount: historyRows.filter((row) => !isHealthyStatus(row.status) || Boolean(row.last_error?.trim())).length,
          oldestTransactionDate: transactionDates[0] ?? null,
          newestTransactionDate: transactionDates.at(-1) ?? null,
        },
        institutionNormalizations: [...normalizationCounts.values()].sort((a, b) => a.canonicalName.localeCompare(b.canonicalName) || a.rawName.localeCompare(b.rawName)),
        genericCards,
        metadataGaps: metadataGaps.slice(0, 25),
        duplicateCandidates,
        history,
        integrity: {
          orphanedAccountProviderRefs: orphaned?.c ?? 0,
          missingConnectionRefs: missingConnection?.c ?? 0,
        },
      };
    },
  };
}
