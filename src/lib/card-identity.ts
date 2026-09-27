export interface CardIdentityInput {
  name: string;
  officialName?: string | null;
  institutionName?: string | null;
  mask?: string | null;
}

export interface CardIdentity {
  issuer: string;
  product: string;
  network: string | null;
  primary: string;
  secondary: string;
  foreground: string;
  confidence: "high" | "medium" | "low";
}

type PaletteRule = {
  test: RegExp;
  issuer: string;
  product: string;
  primary: string;
  secondary: string;
  foreground: string;
  confidence?: CardIdentity["confidence"];
};

const PRODUCT_RULES: PaletteRule[] = [
  { test: /amazon.*prime|prime.*rewards/i, issuer: "Chase", product: "Amazon Prime", primary: "#111827", secondary: "#374151", foreground: "#FFFFFF" },
  { test: /sapphire.*reserve/i, issuer: "Chase", product: "Sapphire Reserve", primary: "#082E4A", secondary: "#176A9A", foreground: "#FFFFFF" },
  { test: /sapphire.*preferred/i, issuer: "Chase", product: "Sapphire Preferred", primary: "#123D67", secondary: "#2C73A9", foreground: "#FFFFFF" },
  { test: /freedom.*(unlimited|flex)|freedom/i, issuer: "Chase", product: "Freedom", primary: "#0B4EA2", secondary: "#4D9DDA", foreground: "#FFFFFF" },
  { test: /blue business plus/i, issuer: "American Express", product: "Blue Business Plus", primary: "#006FCF", secondary: "#55A9E2", foreground: "#FFFFFF" },
  { test: /business gold|american express.*gold|amex.*gold|\bgold card\b/i, issuer: "American Express", product: "Gold", primary: "#A67C2E", secondary: "#E4C778", foreground: "#15120B" },
  { test: /platinum/i, issuer: "American Express", product: "Platinum", primary: "#8B949C", secondary: "#D6DADD", foreground: "#111827" },
  { test: /american express.*green|amex.*green|\bgreen card\b/i, issuer: "American Express", product: "Green", primary: "#1F6047", secondary: "#4E9470", foreground: "#FFFFFF" },
  { test: /bonvoy|marriott/i, issuer: "Marriott", product: "Bonvoy", primary: "#5E2430", secondary: "#B58B6B", foreground: "#FFFFFF" },
  { test: /southwest/i, issuer: "Southwest", product: "Rapid Rewards", primary: "#1B5CA8", secondary: "#D71920", foreground: "#FFFFFF" },
  { test: /united.*(quest|explorer|club)|\bunited\b/i, issuer: "United", product: "MileagePlus", primary: "#0A2747", secondary: "#1D5FB8", foreground: "#FFFFFF" },
  { test: /hyatt/i, issuer: "Hyatt", product: "World of Hyatt", primary: "#293A6D", secondary: "#A88B5D", foreground: "#FFFFFF" },
  { test: /\bihg\b/i, issuer: "IHG", product: "Rewards", primary: "#202020", secondary: "#A98F69", foreground: "#FFFFFF" },
];

function inferNetwork(text: string): string | null {
  if (/visa/i.test(text)) return "VISA";
  if (/mastercard/i.test(text)) return "MC";
  if (/american express|amex/i.test(text)) return "AMEX";
  if (/discover/i.test(text)) return "DISCOVER";
  return null;
}

export function predictCardIdentity(input: CardIdentityInput): CardIdentity {
  const text = [input.name, input.officialName, input.institutionName].filter(Boolean).join(" ");
  const network = inferNetwork(text);
  const rule = PRODUCT_RULES.find((candidate) => candidate.test.test(text));
  if (rule) return { ...rule, network: network ?? (rule.issuer === "American Express" ? "AMEX" : null), confidence: rule.confidence ?? "high" };

  if (/american express|amex/i.test(text)) {
    return { issuer: "American Express", product: "Card", network: network ?? "AMEX", primary: "#006FCF", secondary: "#3E9ED8", foreground: "#FFFFFF", confidence: "medium" };
  }
  if (/chase/i.test(text)) {
    return { issuer: "Chase", product: "Card", network, primary: "#0B5CAB", secondary: "#4B8FC4", foreground: "#FFFFFF", confidence: "medium" };
  }
  return { issuer: input.institutionName ?? "Card", product: "Credit", network, primary: "#334155", secondary: "#64748B", foreground: "#FFFFFF", confidence: "low" };
}
