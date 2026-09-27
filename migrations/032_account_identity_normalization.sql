-- 032: Canonical institution aliases and durable credit-card product identity.
-- Institution aliases may be global (user_id NULL) or user-specific; user
-- aliases take precedence. Card products are a small built-in catalog whose
-- colors are deliberately product/issuer driven rather than app-theme driven.

CREATE TABLE institution_aliases (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  alias_key TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_institution_aliases_system
  ON institution_aliases(alias_key) WHERE user_id IS NULL;
CREATE UNIQUE INDEX idx_institution_aliases_user
  ON institution_aliases(user_id, alias_key) WHERE user_id IS NOT NULL;
CREATE INDEX idx_institution_aliases_canonical
  ON institution_aliases(canonical_name);

INSERT INTO institution_aliases (id, user_id, alias_key, canonical_name, source, created_at, updated_at) VALUES
  ('sys:inst:chase', NULL, 'chase', 'Chase Bank', 'system', datetime('now'), datetime('now')),
  ('sys:inst:chase-bank', NULL, 'chasebank', 'Chase Bank', 'system', datetime('now'), datetime('now')),
  ('sys:inst:jpmorgan-chase', NULL, 'jpmorganchase', 'Chase Bank', 'system', datetime('now'), datetime('now')),
  ('sys:inst:jpmorgan-chase-bank', NULL, 'jpmorganchasebank', 'Chase Bank', 'system', datetime('now'), datetime('now')),
  ('sys:inst:jpmorgan-chase-bank-na', NULL, 'jpmorganchasebankna', 'Chase Bank', 'system', datetime('now'), datetime('now')),
  ('sys:inst:amex', NULL, 'amex', 'American Express', 'system', datetime('now'), datetime('now')),
  ('sys:inst:american-express', NULL, 'americanexpress', 'American Express', 'system', datetime('now'), datetime('now')),
  ('sys:inst:american-express-nb', NULL, 'americanexpressnationalbank', 'American Express', 'system', datetime('now'), datetime('now')),
  ('sys:inst:capital-one', NULL, 'capitalone', 'Capital One', 'system', datetime('now'), datetime('now')),
  ('sys:inst:capital-one-na', NULL, 'capitalonebankusana', 'Capital One', 'system', datetime('now'), datetime('now')),
  ('sys:inst:citi', NULL, 'citi', 'Citi', 'system', datetime('now'), datetime('now')),
  ('sys:inst:citibank', NULL, 'citibank', 'Citi', 'system', datetime('now'), datetime('now')),
  ('sys:inst:bank-of-america', NULL, 'bankofamerica', 'Bank of America', 'system', datetime('now'), datetime('now')),
  ('sys:inst:bank-of-america-na', NULL, 'bankofamericanationalassociation', 'Bank of America', 'system', datetime('now'), datetime('now')),
  ('sys:inst:wells-fargo', NULL, 'wellsfargo', 'Wells Fargo', 'system', datetime('now'), datetime('now')),
  ('sys:inst:wells-fargo-bank', NULL, 'wellsfargobankna', 'Wells Fargo', 'system', datetime('now'), datetime('now')),
  ('sys:inst:discover', NULL, 'discover', 'Discover', 'system', datetime('now'), datetime('now')),
  ('sys:inst:discover-bank', NULL, 'discoverbank', 'Discover', 'system', datetime('now'), datetime('now')),
  ('sys:inst:us-bank', NULL, 'usbank', 'U.S. Bank', 'system', datetime('now'), datetime('now'));

CREATE TABLE card_products (
  key TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  product TEXT NOT NULL,
  network TEXT,
  primary_color TEXT NOT NULL,
  secondary_color TEXT NOT NULL,
  foreground_color TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  match_confidence TEXT NOT NULL DEFAULT 'exact'
    CHECK (match_confidence IN ('exact','likely')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_card_products_issuer ON card_products(issuer, active);

INSERT INTO card_products (
  key, issuer, product, network, primary_color, secondary_color,
  foreground_color, aliases_json, match_confidence, active, created_at, updated_at
) VALUES
  ('chase_amazon_prime', 'Chase', 'Amazon Prime', 'VISA', '#111827', '#374151', '#FFFFFF', '["amazon prime rewards","amazon prime visa","prime visa","amazon visa"]', 'exact', 1, datetime('now'), datetime('now')),
  ('chase_sapphire_reserve', 'Chase', 'Sapphire Reserve', 'VISA', '#082E4A', '#176A9A', '#FFFFFF', '["sapphire reserve"]', 'exact', 1, datetime('now'), datetime('now')),
  ('chase_sapphire_preferred', 'Chase', 'Sapphire Preferred', 'VISA', '#123D67', '#2C73A9', '#FFFFFF', '["sapphire preferred"]', 'exact', 1, datetime('now'), datetime('now')),
  ('chase_freedom_unlimited', 'Chase', 'Freedom Unlimited', 'VISA', '#0B4EA2', '#4D9DDA', '#FFFFFF', '["freedom unlimited"]', 'exact', 1, datetime('now'), datetime('now')),
  ('chase_freedom_flex', 'Chase', 'Freedom Flex', 'MC', '#0B4EA2', '#4D9DDA', '#FFFFFF', '["freedom flex"]', 'exact', 1, datetime('now'), datetime('now')),
  ('amex_blue_business_plus', 'American Express', 'Blue Business Plus', 'AMEX', '#006FCF', '#55A9E2', '#FFFFFF', '["blue business plus"]', 'exact', 1, datetime('now'), datetime('now')),
  ('amex_business_gold', 'American Express', 'Business Gold', 'AMEX', '#A67C2E', '#E4C778', '#15120B', '["business gold"]', 'exact', 1, datetime('now'), datetime('now')),
  ('amex_gold', 'American Express', 'Gold', 'AMEX', '#A67C2E', '#E4C778', '#15120B', '["american express gold","amex gold","gold card"]', 'exact', 1, datetime('now'), datetime('now')),
  ('amex_platinum', 'American Express', 'Platinum', 'AMEX', '#8B949C', '#D6DADD', '#111827', '["american express platinum","amex platinum","platinum card"]', 'exact', 1, datetime('now'), datetime('now')),
  ('amex_green', 'American Express', 'Green', 'AMEX', '#1F6047', '#4E9470', '#FFFFFF', '["american express green","amex green","green card"]', 'exact', 1, datetime('now'), datetime('now')),
  ('marriott_bonvoy', 'Marriott', 'Bonvoy', 'VISA', '#5E2430', '#B58B6B', '#FFFFFF', '["marriott bonvoy","bonvoy"]', 'likely', 1, datetime('now'), datetime('now')),
  ('southwest_rapid_rewards', 'Southwest', 'Rapid Rewards', 'VISA', '#1B5CA8', '#D71920', '#FFFFFF', '["southwest rapid rewards","southwest"]', 'likely', 1, datetime('now'), datetime('now')),
  ('united_mileageplus', 'United', 'MileagePlus', 'VISA', '#0A2747', '#1D5FB8', '#FFFFFF', '["united quest","united explorer","united club","united mileageplus"]', 'likely', 1, datetime('now'), datetime('now')),
  ('hyatt_world', 'Hyatt', 'World of Hyatt', 'VISA', '#293A6D', '#A88B5D', '#FFFFFF', '["world of hyatt","hyatt"]', 'likely', 1, datetime('now'), datetime('now')),
  ('ihg_rewards', 'IHG', 'Rewards', 'MC', '#202020', '#A98F69', '#FFFFFF', '["ihg rewards","ihg"]', 'likely', 1, datetime('now'), datetime('now'));

CREATE TABLE account_card_identity_overrides (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_key TEXT REFERENCES card_products(key) ON DELETE SET NULL,
  issuer TEXT,
  product TEXT,
  network TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (product_key IS NOT NULL OR issuer IS NOT NULL OR product IS NOT NULL)
);
CREATE INDEX idx_account_card_identity_overrides_user
  ON account_card_identity_overrides(user_id);
