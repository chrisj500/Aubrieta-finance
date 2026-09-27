import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Account mutations that remain on the institution-first page must surface
 * failures visibly. Type/privacy/net-worth updates are consolidated into one
 * bulk mutation; name/note edits share one compact metadata editor.
 */
const SRC = path.resolve(__dirname, "../src/app/(app)/accounts/page.tsx");

function mutationBody(src: string, name: string): string {
  const start = src.indexOf(`const ${name} = useMutation(`);
  if (start < 0) throw new Error(`mutation not found: ${name}`);
  let i = src.indexOf("{", start) + 1;
  let depth = 1;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
  }
  return src.slice(start, i);
}

describe("accounts inline-edit mutations surface errors", () => {
  const src = readFileSync(SRC, "utf8");

  it("renders a page-level error banner", () => {
    expect(src).toContain("{actionError && (");
    expect(src).toMatch(/<p role="alert"[\s\S]*text-danger">\s*\{actionError\}/);
  });

  for (const name of ["restore", "bulkUpdate", "updateAccountMeta"]) {
    it(`${name} has onError -> setActionError`, () => {
      const body = mutationBody(src, name);
      expect(body).toContain("onError");
      expect(body).toContain("setActionError(");
    });
  }
});
