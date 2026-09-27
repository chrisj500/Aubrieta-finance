export type CardIdentityConfidence = "exact" | "likely" | "generic";
export type CardIdentitySource = "predicted" | "override";

export interface CardIdentity {
  productKey: string | null;
  issuer: string;
  product: string;
  network: string | null;
  primary: string;
  secondary: string;
  foreground: string;
  confidence: CardIdentityConfidence;
  source: CardIdentitySource;
}

export interface CardProduct {
  key: string;
  issuer: string;
  product: string;
  network: string | null;
  primary: string;
  secondary: string;
  foreground: string;
  aliases: string[];
  matchConfidence: "exact" | "likely";
}
