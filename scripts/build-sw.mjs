#!/usr/bin/env node
/**
 * Compile src/app/sw.ts into sw.js for Turbopack builds.
 *
 * @serwist/next cannot emit the service worker under `next build --turbopack`,
 * so esbuild compiles the worker and @serwist/build supplies the precache
 * manifest.
 *
 * Usage:
 *   node scripts/build-sw.mjs           # static mobile/Pages export
 *   node scripts/build-sw.mjs --server  # standalone server build
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { getManifest } from "@serwist/build";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const serverMode = process.argv.includes("--server");

// build-mobile.mjs invokes pnpm build while MOBILE_EXPORT=1, then calls this
// script again after the static export is complete. Do not emit a server SW in
// the middle of that flow.
if (serverMode && process.env.MOBILE_EXPORT === "1") {
  console.log("↷ server sw.js skipped during mobile export");
  process.exit(0);
}

let out;
let manifestEntries;

if (serverMode) {
  if (!fs.existsSync(path.join(root, ".next", "standalone", "server.js"))) {
    console.error(".next/standalone missing — run the server Next build first");
    process.exit(1);
  }

  out = path.join(root, "public", "sw.js");
  const manifestResult = await getManifest({
    globDirectory: path.join(root, "public"),
    globPatterns: ["manifest.webmanifest", "icon.svg", "apple-icon.png"],
    globIgnores: ["sw.js", "sw.js.map"],
    maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
  });
  manifestEntries = [
    ...(manifestResult.manifestEntries ?? []),
    // /offline is a server-rendered route, not a file under public/. Include it
    // explicitly so the navigation fallback works on a cold offline launch.
    { url: "/offline", revision: null },
  ];
} else {
  out = path.join(root, "dist", "mobile", "sw.js");
  if (!fs.existsSync(path.join(root, "dist", "mobile", "index.html"))) {
    console.error("dist/mobile missing — run build-mobile.mjs first");
    process.exit(1);
  }

  const manifestResult = await getManifest({
    globDirectory: path.join(root, "dist", "mobile"),
    globPatterns: ["**/*.html", "manifest.webmanifest", "icon.svg", "apple-icon.png", "offline.html"],
    globIgnores: ["sw.js", "sw.js.map", "sql-wasm.wasm", "404.html"],
    maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
  });
  manifestEntries = manifestResult.manifestEntries ?? [];
}

const result = await build({
  entryPoints: [path.join(root, "src", "app", "sw.ts")],
  bundle: true,
  outfile: out,
  format: "iife",
  target: "es2017",
  minify: true,
  sourcemap: false,
  define: { "self.__SW_MANIFEST": JSON.stringify(manifestEntries) },
});

if (!fs.existsSync(out) || fs.statSync(out).size === 0) {
  console.error("sw.js emit failed", result.errors);
  process.exit(1);
}
console.log(`✅ sw.js compiled (${manifestEntries.length} precache entries) → ${path.relative(root, out)}`);
