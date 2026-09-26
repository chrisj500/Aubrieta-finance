import type { Db } from "@/server/db/types";
import type { ProviderCapability } from "@/server/providers/types";

export type ConnectionHealthState = "healthy" | "needs_attention";

export interface ConnectionHealthItem {
  id: string;
  provider: string;
  providerName: string;
  institutionName: string;
  environment: string | null;
  state: ConnectionHealthState;
  rawStatus: string;
  lastSuccessfulSyncAt: string | null;
  lastError: string | null;
  updatedAt: string;
  capabilities: ProviderCapability[];
  supportsRefresh: boolean;
  supportsReauth: boolean;
  accountCount: number;
  accountNames: string[];
}

export interface ConnectionHealthResult {
  summary: {
    connectionCount: number;
    healthyCount: number;
    needsAttentionCount: number;
    neverSyncedCount: number;
    manualAccountCount: number;
    lastSuccessfulSyncAt: string | null;
  };
  connections: ConnectionHealthItem[];
}

const PROVIDER_NAMES: Record<string, string> = {
  plaid: "Plaid",
  teller: "Teller",
  simplefin: "SimpleFIN",
  akoya: "Akoya / FDX",
  file: "File import",
  demo: "Aubrieta Demo",
};

function providerName(provider: string): string {
  const known = PROVIDER_NAMES[provider];
  if (known) return known;
  return provider
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const CAPABILITIES = new Set<ProviderCapability>([
  "accounts",
  "balances",
  "transactions",
  "liabilities",
  "investments",
  "statements",
  "recurring",
  "webhooks",
  "refresh",
  "reauth",
]);

function parseCapabilities(raw: string): ProviderCapability[] {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .filter((v): v is ProviderCapability => typeof v === "string" && CAPABILITIES.has(v as ProviderCapability))
      .filter((v, i, all) => all.indexOf(v) === i)
      .sort();
  } catch {
    return [];
  }
}

function isHealthyStatus(status: string): boolean {
  return status === "active" || status === "linked";
}

export function createConnectionHealthService(db: Db) {
  return {
    async get(userId: string): Promise<ConnectionHealthResult> {
      const rows = await db.all<{
        id: string;
        provider: string;
        institution_name: string | null;
        environment: string | null;
        status: string;
        capabilities_json: string;
        last_sync_at: string | null;
        last_error: string | null;
        updated_at: string;
      }>(
        `SELECT id, provider, institution_name, environment, status,
                capabilities_json, last_sync_at, last_error, updated_at
           FROM provider_connections
          WHERE user_id = ?`,
        userId,
      );

      const connections: ConnectionHealthItem[] = [];
      for (const row of rows) {
        const accounts = await db.all<{ name: string }>(
          `SELECT a.name
             FROM account_provider_refs apr
             JOIN accounts a ON a.id = apr.account_id
            WHERE apr.user_id = ? AND apr.connection_id = ?
              AND a.deleted_at IS NULL`,
          userId,
          row.id,
        );
        const accountNames = accounts.map((a) => a.name).sort((a, b) => a.localeCompare(b));
        const capabilities = parseCapabilities(row.capabilities_json);
        const lastError = row.last_error?.trim() || null;
        const provider = row.provider;
        const displayName = providerName(provider);
        connections.push({
          id: row.id,
          provider,
          providerName: displayName,
          institutionName: row.institution_name?.trim() || `${displayName} connection`,
          environment: row.environment,
          state: isHealthyStatus(row.status) && !lastError ? "healthy" : "needs_attention",
          rawStatus: row.status,
          lastSuccessfulSyncAt: row.last_sync_at,
          lastError,
          updatedAt: row.updated_at,
          capabilities,
          supportsRefresh: capabilities.includes("refresh"),
          supportsReauth: capabilities.includes("reauth"),
          accountCount: accountNames.length,
          accountNames,
        });
      }

      connections.sort((a, b) => {
        if (a.state !== b.state) return a.state === "needs_attention" ? -1 : 1;
        return a.institutionName.localeCompare(b.institutionName);
      });

      const manual = await db.get<{ c: number }>(
        `SELECT COUNT(*) AS c
           FROM accounts a
          WHERE a.user_id = ? AND a.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM account_provider_refs apr WHERE apr.account_id = a.id
            )`,
        userId,
      );
      const syncTimes = connections
        .map((c) => c.lastSuccessfulSyncAt)
        .filter((v): v is string => Boolean(v))
        .sort();

      return {
        summary: {
          connectionCount: connections.length,
          healthyCount: connections.filter((c) => c.state === "healthy").length,
          needsAttentionCount: connections.filter((c) => c.state === "needs_attention").length,
          neverSyncedCount: connections.filter((c) => !c.lastSuccessfulSyncAt).length,
          manualAccountCount: manual?.c ?? 0,
          lastSuccessfulSyncAt: syncTimes.at(-1) ?? null,
        },
        connections,
      };
    },
  };
}
