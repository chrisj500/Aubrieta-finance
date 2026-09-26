#!/usr/bin/env node
/**
 * Build the P8b solo mobile export (dist/mobile).
 *
 * The main app is a Next.js server app (65 API routes) — `output: "export"`
 * refuses to build with route handlers present. The webview doesn't need the
 * HTTP routes (the solo router answers /api/* in-process), so this script:
 *
 *   1. Temporarily moves server-only routes aside: src/app/api, the MCP
 *      route handler, and /accounts/[id] (arbitrary runtime ids cannot be
 *      pre-rendered by Next static export).
 *   2. Builds with `MOBILE_EXPORT=1` → next.config switches to
 *      `output: "export"` + `distDir: "dist/mobile"`. Account detail stays
 *      available through the static /account?id=… route.
 *   3. Restores every server-only route (finally).
 *
 * Usage: node scripts/build-mobile.mjs   (run AFTER `pnpm build`)
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const API_DIR = path.join(root, "src", "app", "api");
// Backup lives OUTSIDE src/app so Next never scans it as routes.
const API_BAK = path.join(root, "scripts", ".api-mobile-bak");
// Server-only proxy route that re-exports from src/app/api — also hidden.
const MCP_ROUTE = path.join(root, "src", "app", "mcp", "route.ts");
const MCP_ROUTE_BAK = path.join(root, "src", "app", "mcp", ".route.ts-mobile-bak");
// Server-only pretty URL. The static export uses /account?id=… instead.
const ACCOUNT_DETAIL_DIR = path.join(root, "src", "app", "(app)", "accounts", "[id]");
const ACCOUNT_DETAIL_BAK = path.join(root, "scripts", ".account-detail-mobile-bak");

function hideApi() {
  if (fs.existsSync(API_DIR) && !fs.existsSync(API_BAK)) {
    fs.renameSync(API_DIR, API_BAK);
    console.log("src/app/api → scripts/.api-mobile-bak (hidden from export build)");
  }
  if (fs.existsSync(MCP_ROUTE) && !fs.existsSync(MCP_ROUTE_BAK)) {
    fs.renameSync(MCP_ROUTE, MCP_ROUTE_BAK);
    console.log("src/app/mcp/route.ts hidden (server-only MCP proxy)");
  }
  if (fs.existsSync(ACCOUNT_DETAIL_DIR) && !fs.existsSync(ACCOUNT_DETAIL_BAK)) {
    fs.renameSync(ACCOUNT_DETAIL_DIR, ACCOUNT_DETAIL_BAK);
    console.log("src/app/(app)/accounts/[id] hidden (static export uses /account?id=...)");
  }
}

function restoreApi() {
  if (fs.existsSync(API_BAK) && !fs.existsSync(API_DIR)) {
    fs.renameSync(API_BAK, API_DIR);
    console.log("scripts/.api-mobile-bak → src/app/api (restored)");
  }
  if (fs.existsSync(MCP_ROUTE_BAK) && !fs.existsSync(MCP_ROUTE)) {
    fs.renameSync(MCP_ROUTE_BAK, MCP_ROUTE);
    console.log("src/app/mcp/route.ts restored");
  }
  if (fs.existsSync(ACCOUNT_DETAIL_BAK) && !fs.existsSync(ACCOUNT_DETAIL_DIR)) {
    fs.renameSync(ACCOUNT_DETAIL_BAK, ACCOUNT_DETAIL_DIR);
    console.log("src/app/(app)/accounts/[id] restored");
  }
}

try {
  hideApi();
  execSync("npm run build", {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, MOBILE_EXPORT: "1" },
  });
  // Copy sql.js's wasm binary into the export root — BrowserSqliteDb locates
  // it via locateFile at `${NEXT_PUBLIC_BASE_PATH}/sql-wasm.wasm` (works under
  // the GitHub Pages subpath AND the APK's root origin).
  const wasmSrc = path.join(root, "node_modules", "sql.js", "dist", "sql-wasm.wasm");
  const wasmDest = path.join(root, "dist", "mobile", "sql-wasm.wasm");
  if (fs.existsSync(wasmSrc) && !fs.existsSync(wasmDest)) {
    fs.copyFileSync(wasmSrc, wasmDest);
    console.log("sql-wasm.wasm copied into dist/mobile (browser-solo SQLite)");
  }
  const out = path.join(root, "dist", "mobile");
  if (!fs.existsSync(path.join(out, "index.html"))) {
    throw new Error(`dist/mobile/index.html missing — export failed?`);
  }
  console.log(`✅ mobile export ready at ${path.relative(root, out)}`);
  // Serwist cannot emit sw.js under turbopack — compile it separately.
  execSync("node scripts/build-sw.mjs", { cwd: root, stdio: "inherit" });
} finally {
  restoreApi();
}
