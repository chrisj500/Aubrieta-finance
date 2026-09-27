import { randomUUID } from "@/lib/uuid";
import { apiErrors } from "@/lib/api-error";
import type { Db } from "@/server/db/types";
import { assertAccountManageable } from "@/server/authz/household-access";
import type { CardIdentity, CardIdentityConfidence, CardIdentitySource, CardProduct } from "@/lib/card-identity";

export function normalizeInstitutionKey(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface InstitutionAliasRow {
  alias_key: string;
  canonical_name: string;
  user_id: string | null;
}

export async function createInstitutionNormalizer(db: Db, userId: string): Promise<(raw: string | null | undefined) => string | null> {
  const rows = await db.all<InstitutionAliasRow>(
    `SELECT alias_key, canonical_name, user_id
       FROM institution_aliases
      WHERE user_id IS NULL OR user_id = ?
      ORDER BY CASE WHEN user_id = ? THEN 0 ELSE 1 END`,
    userId,
    userId,
  );
  const aliases = new Map<string, string>();
  for (const row of rows) {
    if (!aliases.has(row.alias_key)) aliases.set(row.alias_key, row.canonical_name);
  }
  return (raw) => {
    const trimmed = raw?.trim();
    if (!trimmed) return null;
    return aliases.get(normalizeInstitutionKey(trimmed)) ?? trimmed;
  };
}

export async function setInstitutionAlias(db: Db, userId: string, rawName: string, canonicalName: string): Promise<void> {
  const aliasKey = normalizeInstitutionKey(rawName);
  const canonical = canonicalName.trim();
  if (!aliasKey || !canonical) throw apiErrors.badRequest("Institution names cannot be empty.");
  const existing = await db.get<{ id: string }>(
    "SELECT id FROM institution_aliases WHERE user_id = ? AND alias_key = ?",
    userId,
    aliasKey,
  );
  const timestamp = new Date().toISOString();
  if (existing) {
    await db.run(
      "UPDATE institution_aliases SET canonical_name = ?, source = 'user', updated_at = ? WHERE id = ?",
      canonical,
      timestamp,
      existing.id,
    );
  } else {
    await db.run(
      `INSERT INTO institution_aliases (id, user_id, alias_key, canonical_name, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'user', ?, ?)`,
      randomUUID(),
      userId,
      aliasKey,
      canonical,
      timestamp,
      timestamp,
    );
  }
}

interface CardProductRow {
  key: string;
  issuer: string;
  product: string;
  network: string | null;
  primary_color: string;
  secondary_color: string;
  foreground_color: string;
  aliases_json: string;
  match_confidence: "exact" | "likely";
}

interface CardOverrideRow {
  account_id: string;
  product_key: string | null;
  issuer: string | null;
  product: string | null;
  network: string | null;
}

export function rowToCardProduct(row: CardProductRow): CardProduct {
  let aliases: string[] = [];
  try {
    const parsed = JSON.parse(row.aliases_json) as unknown;
    if (Array.isArray(parsed)) aliases = parsed.filter((v): v is string => typeof v === "string");
  } catch {
    aliases = [];
  }
  return {
    key: row.key,
    issuer: row.issuer,
    product: row.product,
    network: row.network,
    primary: row.primary_color,
    secondary: row.secondary_color,
    foreground: row.foreground_color,
    aliases,
    matchConfidence: row.match_confidence,
  };
}

export async function listCardProducts(db: Db): Promise<CardProduct[]> {
  const rows = await db.all<CardProductRow>(
    `SELECT key, issuer, product, network, primary_color, secondary_color,
            foreground_color, aliases_json, match_confidence
       FROM card_products
      WHERE active = 1
      ORDER BY issuer COLLATE NOCASE, product COLLATE NOCASE`,
  );
  return rows.map(rowToCardProduct);
}

function inferNetwork(text: string): string | null {
  if (/\bvisa\b/i.test(text)) return "VISA";
  if (/\bmastercard\b|\bmaster card\b/i.test(text)) return "MC";
  if (/american express|\bamex\b/i.test(text)) return "AMEX";
  if (/\bdiscover\b/i.test(text)) return "DISCOVER";
  return null;
}

const ISSUER_PALETTES: Array<{ test: RegExp; issuer: string; primary: string; secondary: string; foreground: string; network?: string }> = [
  { test: /american express|amex/i, issuer: "American Express", primary: "#006FCF", secondary: "#3E9ED8", foreground: "#FFFFFF", network: "AMEX" },
  { test: /chase|jpmorgan/i, issuer: "Chase", primary: "#0B5CAB", secondary: "#4B8FC4", foreground: "#FFFFFF" },
  { test: /capital one/i, issuer: "Capital One", primary: "#003B70", secondary: "#D21F2B", foreground: "#FFFFFF" },
  { test: /citi|citibank/i, issuer: "Citi", primary: "#056DAE", secondary: "#D9262E", foreground: "#FFFFFF" },
  { test: /discover/i, issuer: "Discover", primary: "#111827", secondary: "#F58220", foreground: "#FFFFFF", network: "DISCOVER" },
  { test: /bank of america/i, issuer: "Bank of America", primary: "#C41230", secondary: "#0052A4", foreground: "#FFFFFF" },
  { test: /wells fargo/i, issuer: "Wells Fargo", primary: "#B31B34", secondary: "#D6B36A", foreground: "#FFFFFF" },
  { test: /u\.s\. bank|us bank/i, issuer: "U.S. Bank", primary: "#0C2074", secondary: "#D71920", foreground: "#FFFFFF" },
];

function issuerFallback(text: string, institutionName: string | null | undefined): Omit<CardIdentity, "product" | "confidence" | "source" | "productKey"> {
  const combined = `${institutionName ?? ""} ${text}`;
  const hit = ISSUER_PALETTES.find((candidate) => candidate.test.test(combined));
  if (hit) {
    return {
      issuer: hit.issuer,
      network: inferNetwork(text) ?? hit.network ?? null,
      primary: hit.primary,
      secondary: hit.secondary,
      foreground: hit.foreground,
    };
  }
  return {
    issuer: institutionName?.trim() || "Card",
    network: inferNetwork(text),
    primary: "#334155",
    secondary: "#64748B",
    foreground: "#FFFFFF",
  };
}

function fromProduct(product: CardProduct, source: CardIdentitySource, confidence: CardIdentityConfidence = product.matchConfidence): CardIdentity {
  return {
    productKey: product.key,
    issuer: product.issuer,
    product: product.product,
    network: product.network,
    primary: product.primary,
    secondary: product.secondary,
    foreground: product.foreground,
    confidence,
    source,
  };
}

export interface CardIdentityAccountInput {
  id: string;
  name: string;
  official_name?: string | null;
  institution_name?: string | null;
  mask?: string | null;
  type?: string | null;
}

export async function resolveCardIdentities(
  db: Db,
  userId: string,
  accounts: CardIdentityAccountInput[],
): Promise<Map<string, CardIdentity>> {
  const creditAccounts = accounts.filter((account) => account.type === "credit");
  if (creditAccounts.length === 0) return new Map();

  const [products, overrides] = await Promise.all([
    listCardProducts(db),
    db.all<CardOverrideRow>(
      `SELECT account_id, product_key, issuer, product, network
         FROM account_card_identity_overrides
        WHERE user_id = ?`,
      userId,
    ),
  ]);
  const productByKey = new Map(products.map((product) => [product.key, product]));
  const overrideByAccount = new Map(overrides.map((override) => [override.account_id, override]));
  const candidates = products.flatMap((product) =>
    product.aliases.map((alias) => ({
      alias: normalizeSearchText(alias),
      product,
    })),
  ).sort((a, b) => b.alias.length - a.alias.length);

  const result = new Map<string, CardIdentity>();
  for (const account of creditAccounts) {
    const text = [account.name, account.official_name, account.institution_name].filter(Boolean).join(" ");
    const normalizedText = normalizeSearchText(text);
    const override = overrideByAccount.get(account.id);
    if (override) {
      if (override.product_key && productByKey.has(override.product_key)) {
        result.set(account.id, fromProduct(productByKey.get(override.product_key)!, "override", "exact"));
        continue;
      }
      const fallback = issuerFallback(`${override.issuer ?? ""} ${override.product ?? ""} ${text}`, override.issuer ?? account.institution_name);
      result.set(account.id, {
        productKey: null,
        issuer: override.issuer?.trim() || fallback.issuer,
        product: override.product?.trim() || "Card",
        network: override.network?.trim() || fallback.network,
        primary: fallback.primary,
        secondary: fallback.secondary,
        foreground: fallback.foreground,
        confidence: "exact",
        source: "override",
      });
      continue;
    }

    const matched = candidates.find((candidate) => candidate.alias && normalizedText.includes(candidate.alias));
    if (matched) {
      result.set(account.id, fromProduct(matched.product, "predicted"));
      continue;
    }

    const fallback = issuerFallback(text, account.institution_name);
    const recognizedIssuer = fallback.issuer !== (account.institution_name?.trim() || "Card") || ISSUER_PALETTES.some((candidate) => candidate.test.test(`${account.institution_name ?? ""} ${text}`));
    result.set(account.id, {
      productKey: null,
      ...fallback,
      product: "Card",
      confidence: recognizedIssuer ? "likely" : "generic",
      source: "predicted",
    });
  }
  return result;
}

export async function setCardIdentityOverride(
  db: Db,
  userId: string,
  accountId: string,
  input: { productKey?: string | null; issuer?: string | null; product?: string | null; network?: string | null },
): Promise<void> {
  await assertAccountManageable(db, userId, accountId);
  const productKey = input.productKey?.trim() || null;
  const issuer = input.issuer?.trim() || null;
  const product = input.product?.trim() || null;
  const network = input.network?.trim() || null;
  if (!productKey && !issuer && !product) throw apiErrors.badRequest("Choose a known product or provide an issuer/product override.");
  if (productKey) {
    const exists = await db.get<{ key: string }>("SELECT key FROM card_products WHERE key = ? AND active = 1", productKey);
    if (!exists) throw apiErrors.badRequest("Unknown card product.");
  }
  const timestamp = new Date().toISOString();
  const existing = await db.get<{ account_id: string }>("SELECT account_id FROM account_card_identity_overrides WHERE account_id = ?", accountId);
  if (existing) {
    await db.run(
      `UPDATE account_card_identity_overrides
          SET product_key = ?, issuer = ?, product = ?, network = ?, updated_at = ?
        WHERE account_id = ?`,
      productKey,
      issuer,
      product,
      network,
      timestamp,
      accountId,
    );
  } else {
    await db.run(
      `INSERT INTO account_card_identity_overrides
       (account_id, user_id, product_key, issuer, product, network, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      accountId,
      userId,
      productKey,
      issuer,
      product,
      network,
      timestamp,
      timestamp,
    );
  }
}

export async function clearCardIdentityOverride(db: Db, userId: string, accountId: string): Promise<void> {
  await assertAccountManageable(db, userId, accountId);
  await db.run("DELETE FROM account_card_identity_overrides WHERE account_id = ? AND user_id = ?", accountId, userId);
}
