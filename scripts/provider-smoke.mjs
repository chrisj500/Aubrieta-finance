#!/usr/bin/env node

const OPT_IN = "YES_I_UNDERSTAND";
const PROVIDERS = new Set(["plaid", "teller", "simplefin", "akoya"]);
const LIABILITY_TYPES = new Set(["credit", "loan"]);

function fail(message) {
  console.error(`M5.7 provider smoke FAILED: ${message}`);
  process.exitCode = 1;
  throw new Error("__SMOKE_ABORT__");
}

function envList(name) {
  return (process.env[name] ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

function safeBaseUrl() {
  const raw = process.env.AUBRIETA_SMOKE_BASE_URL;
  if (!raw) fail("AUBRIETA_SMOKE_BASE_URL is required.");
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail("AUBRIETA_SMOKE_BASE_URL must be a valid URL.");
  }
  const local = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    fail("Refusing to send an authenticated smoke session over remote plain HTTP.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") + "/";
  url.search = "";
  url.hash = "";
  return url;
}

function targetProviders() {
  const providers = envList("AUBRIETA_SMOKE_PROVIDERS");
  if (providers.length === 0) {
    fail("AUBRIETA_SMOKE_PROVIDERS must explicitly name at least one provider.");
  }
  for (const provider of providers) {
    if (!PROVIDERS.has(provider)) fail(`Unsupported smoke provider: ${provider}.`);
  }
  return [...new Set(providers)];
}

function sessionCookieFromSetCookie(raw) {
  const match = raw?.match(/(?:^|,\s*)of_session=([^;]+)/);
  return match ? `of_session=${match[1]}` : null;
}

async function jsonResponse(response, label) {
  let body;
  try {
    body = await response.json();
  } catch {
    fail(`${label} did not return JSON (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    fail(`${label} failed with HTTP ${response.status}. See Aubrieta logs/Connection health for details.`);
  }
  return body;
}

async function main() {
  if (process.env.AUBRIETA_PROVIDER_SMOKE !== OPT_IN) {
    fail(`Set AUBRIETA_PROVIDER_SMOKE=${OPT_IN} to confirm this live-provider test is intentional.`);
  }

  const base = safeBaseUrl();
  const providers = targetProviders();
  const allowSandbox = process.env.AUBRIETA_SMOKE_ALLOW_SANDBOX === "1";
  let cookie = process.env.AUBRIETA_SMOKE_COOKIE?.trim() || null;

  const request = async (path, init = {}) => {
    const headers = new Headers(init.headers ?? {});
    headers.set("accept", "application/json");
    headers.set("user-agent", "Aubrieta-M5.7-Provider-Smoke/1");
    if (cookie) headers.set("cookie", cookie);
    if ((init.method ?? "GET").toUpperCase() !== "GET") headers.set("x-of-request", "1");
    return fetch(new URL(path.replace(/^\//, ""), base), { ...init, headers, redirect: "error" });
  };

  if (!cookie) {
    const username = process.env.AUBRIETA_SMOKE_USERNAME;
    const password = process.env.AUBRIETA_SMOKE_PASSWORD;
    if (!username || !password) {
      fail("Provide AUBRIETA_SMOKE_COOKIE or both AUBRIETA_SMOKE_USERNAME and AUBRIETA_SMOKE_PASSWORD.");
    }
    const login = await fetch(new URL("api/auth/login", base), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "Aubrieta-M5.7-Provider-Smoke/1",
      },
      body: JSON.stringify({ username, password, duration: "1h" }),
      redirect: "error",
    });
    await jsonResponse(login, "Login");
    const setCookies = typeof login.headers.getSetCookie === "function"
      ? login.headers.getSetCookie()
      : [login.headers.get("set-cookie")].filter(Boolean);
    cookie = setCookies.map(sessionCookieFromSetCookie).find(Boolean) ?? null;
    if (!cookie) fail("Login succeeded but no Aubrieta session cookie was returned.");
  }

  const getHealth = async () => jsonResponse(await request("/api/connections/health"), "Connection health");
  const before = await getHealth();
  const byProvider = new Map();
  for (const provider of providers) {
    const matches = before.connections.filter((c) => c.provider === provider);
    if (matches.length === 0) fail(`No configured ${provider} connection exists for this user.`);
    if (!allowSandbox && matches.some((c) => String(c.environment ?? "").toLowerCase() === "sandbox")) {
      fail(`${provider} includes a sandbox connection. Set AUBRIETA_SMOKE_ALLOW_SANDBOX=1 only for an intentional sandbox run.`);
    }
    byProvider.set(provider, matches);
  }

  const syncPass = async (pass) => {
    const response = await request("/api/transactions/sync", { method: "POST" });
    const body = await jsonResponse(response, `Sync pass ${pass}`);
    for (const provider of providers) {
      const results = body.results.filter((r) => r.provider === provider);
      if (results.length === 0) fail(`Sync pass ${pass} returned no ${provider} result.`);
      if (results.some((r) => r.ok !== true)) {
        fail(`${provider} had ${results.filter((r) => r.ok !== true).length} failed connection(s) on sync pass ${pass}.`);
      }
    }
    return body;
  };

  const assertHealth = async (label, previous = null) => {
    const health = await getHealth();
    for (const provider of providers) {
      const matches = health.connections.filter((c) => c.provider === provider);
      if (matches.length === 0) fail(`${provider} disappeared from Connection health after ${label}.`);
      for (const connection of matches) {
        if (connection.state !== "healthy" || connection.lastError) {
          fail(`${provider} is not healthy after ${label}.`);
        }
        if (!connection.lastSuccessfulSyncAt) fail(`${provider} has no successful-sync timestamp after ${label}.`);
        if (connection.accountCount < 1) fail(`${provider} has no linked accounts after ${label}.`);
        if (previous) {
          const old = previous.connections.find((c) => c.id === connection.id)?.lastSuccessfulSyncAt;
          if (old && Date.parse(connection.lastSuccessfulSyncAt) < Date.parse(old)) {
            fail(`${provider} successful-sync time moved backwards after ${label}.`);
          }
        }
      }
    }
    return health;
  };

  const providerAccountIds = async (provider) => {
    let body;
    if (provider === "plaid") {
      body = await jsonResponse(await request("/api/plaid/items"), "Plaid connections");
      return (body.items ?? []).flatMap((item) => item.accounts ?? []).map((a) => a.id);
    }
    if (provider === "teller") {
      body = await jsonResponse(await request("/api/teller/connections"), "Teller connections");
      return (body.connections ?? []).flatMap((c) => c.accounts ?? []).map((a) => a.id);
    }
    if (provider === "simplefin") {
      body = await jsonResponse(await request("/api/simplefin/connections"), "SimpleFIN connections");
      return (body.connections ?? []).flatMap((c) => c.accounts ?? []).map((a) => a.id);
    }
    body = await jsonResponse(await request("/api/akoya/connections"), "Akoya connections");
    return (body.connections ?? []).flatMap((c) => c.accounts ?? []).map((a) => a.id);
  };

  console.log(`M5.7 provider smoke: ${providers.join(", ")}`);
  console.log("Preflight: configured connection(s) found; no financial values will be printed.");

  await syncPass(1);
  const afterFirst = await assertHealth("first sync");
  console.log("Sync pass 1: PASS");

  for (const provider of providers) {
    const capabilities = new Set(
      afterFirst.connections.filter((c) => c.provider === provider).flatMap((c) => c.capabilities ?? []),
    );
    const ids = [...new Set(await providerAccountIds(provider))];
    if (ids.length === 0) fail(`${provider} connection listing returned no account ids after sync.`);

    let liabilityLike = 0;
    let liabilityRecords = 0;
    for (const id of ids) {
      const detail = await jsonResponse(
        await request(`/api/accounts/${encodeURIComponent(id)}`),
        `${provider} account detail`,
      );
      if (LIABILITY_TYPES.has(detail.account?.type)) liabilityLike++;
      if (detail.liability) liabilityRecords++;
    }
    if (capabilities.has("liabilities") && liabilityLike > 0 && liabilityRecords === 0) {
      fail(`${provider} advertises liabilities and has liability account(s), but no provider liability detail was stored.`);
    }
    const liabilitySummary = capabilities.has("liabilities")
      ? liabilityLike > 0
        ? `${liabilityRecords}/${liabilityLike} liability account(s) returned provider detail`
        : "supported; no liability account connected"
      : "not advertised";
    console.log(`${provider}: ${ids.length} linked account(s); liabilities ${liabilitySummary}`);
  }

  await syncPass(2);
  await assertHealth("resync", afterFirst);
  console.log("Sync pass 2 / resync: PASS");
  console.log("Connection health: PASS");
  console.log("M5.7 provider smoke: PASS");
}

main().catch((err) => {
  if (err instanceof Error && err.message === "__SMOKE_ABORT__") return;
  console.error("M5.7 provider smoke FAILED: unexpected local runner error.");
  process.exitCode = 1;
});
