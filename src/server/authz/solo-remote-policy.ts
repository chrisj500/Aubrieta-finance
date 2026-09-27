/** Browser-safe route policy for the solo/Tailscale remote agent bridge. */
export interface SoloRemoteDecision {
  allowed: boolean;
  code?: "forbidden" | "insufficient_scope";
  missing?: string[];
}

type Policy = { anyOf?: string[]; allOf?: string[] };

const ACCOUNT_READ = ["read:banking", "read:investments"];
const PLANNING_READ = new Set([
  "/api/planning/bills",
  "/api/planning/debts",
  "/api/planning/goals",
  "/api/planning/digest",
  "/api/planning/projection",
]);
const REPORT_READ = new Set([
  "/api/reports/spending-by-category",
  "/api/reports/cashflow",
  "/api/reports/net-worth",
  "/api/reports/spending-trend",
]);

function oneSegmentBelow(base: string, path: string): boolean {
  if (!path.startsWith(`${base}/`)) return false;
  const suffix = path.slice(base.length + 1);
  return suffix.length > 0 && !suffix.includes("/");
}

function policyFor(method: string, path: string): Policy | null {
  if (method === "GET" && ["/api/agent/guide", "/api/agent/manual", "/api/agent/capabilities"].includes(path)) return {};
  if (method === "GET" && ["/api/agent/summary", "/api/summary"].includes(path)) return { allOf: ["read:summary"] };

  if (method === "GET" && path === "/api/accounts") return { anyOf: ACCOUNT_READ };
  if (method === "GET" && oneSegmentBelow("/api/accounts", path) && path !== "/api/accounts/order") return { anyOf: ACCOUNT_READ };

  if (method === "GET" && path === "/api/transactions") return { anyOf: ACCOUNT_READ };
  if (
    method === "GET" &&
    oneSegmentBelow("/api/transactions", path) &&
    !["/api/transactions/sync", "/api/transactions/batch"].includes(path)
  ) return { anyOf: ACCOUNT_READ };
  if (
    method === "PATCH" &&
    oneSegmentBelow("/api/transactions", path) &&
    !["/api/transactions/sync", "/api/transactions/batch"].includes(path)
  ) return { allOf: ["transactions:edit"], anyOf: ACCOUNT_READ };
  if (method === "POST" && path === "/api/transactions/sync") return { allOf: ["sync:run"] };

  if (method === "GET" && path === "/api/budgets") return { allOf: ["read:budgets"] };
  if (method === "POST" && path === "/api/budgets") return { allOf: ["budgets:write"] };
  if (method === "DELETE" && oneSegmentBelow("/api/budgets", path)) return { allOf: ["budgets:write"] };

  if (method === "GET" && path === "/api/categories") return { allOf: ["read:budgets"] };
  if (method === "POST" && path === "/api/categories") return { allOf: ["categories:write"] };
  if (["PATCH", "DELETE"].includes(method) && oneSegmentBelow("/api/categories", path)) return { allOf: ["categories:write"] };

  if (method === "GET" && PLANNING_READ.has(path)) return { allOf: ["read:planning"] };
  if (method === "POST" && ["/api/planning/bills", "/api/planning/debts", "/api/planning/goals"].includes(path)) {
    return { allOf: ["planning:write"] };
  }
  if (
    ["PATCH", "DELETE"].includes(method) &&
    ["/api/planning/bills", "/api/planning/debts", "/api/planning/goals"].some((base) => oneSegmentBelow(base, path))
  ) return { allOf: ["planning:write"] };

  if (method === "GET" && REPORT_READ.has(path)) return { allOf: ["read:reports"] };

  if (["GET", "POST"].includes(method) && path === "/api/custom-views") return { allOf: ["dev:ui"] };
  if (["PATCH", "DELETE"].includes(method) && oneSegmentBelow("/api/custom-views", path)) return { allOf: ["dev:ui"] };

  return null;
}

export function authorizeSoloRemoteRequest(method: string, path: string, scopes: string[]): SoloRemoteDecision {
  const policy = policyFor(method.toUpperCase(), path);
  if (!policy) return { allowed: false, code: "forbidden" };

  const missingAll = (policy.allOf ?? []).filter((scope) => !scopes.includes(scope));
  const anyOf = policy.anyOf ?? [];
  const missingAny = anyOf.length > 0 && !anyOf.some((scope) => scopes.includes(scope)) ? anyOf : [];
  const missing = [...new Set([...missingAll, ...missingAny])];
  if (missing.length > 0) return { allowed: false, code: "insufficient_scope", missing };
  return { allowed: true };
}
