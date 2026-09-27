-- 033: Refine card-product matches observed in real provider data.
-- Specific aliases intentionally outrank broad issuer/product aliases because
-- the resolver sorts aliases longest-first.

INSERT INTO card_products (
  key, issuer, product, network, primary_color, secondary_color,
  foreground_color, aliases_json, match_confidence, active, created_at, updated_at
) VALUES
  ('chase_southwest_priority', 'Southwest', 'Priority', 'VISA', '#1B5CA8', '#D71920', '#FFFFFF', '["southwest priority"]', 'exact', 1, datetime('now'), datetime('now')),
  ('chase_marriott_boundless', 'Marriott', 'Bonvoy Boundless', 'VISA', '#5E2430', '#B58B6B', '#FFFFFF', '["marriott boundless","bonvoy boundless"]', 'exact', 1, datetime('now'), datetime('now')),
  ('chase_freedom_legacy', 'Chase', 'Freedom', 'VISA', '#0B4EA2', '#4D9DDA', '#FFFFFF', '["freedom"]', 'exact', 1, datetime('now'), datetime('now')),
  ('amex_schwab_platinum', 'American Express', 'Schwab Platinum', 'AMEX', '#6B7280', '#D1D5DB', '#111827', '["charles schwab platinum"]', 'exact', 1, datetime('now'), datetime('now')),
  ('amex_delta_reserve_business', 'American Express', 'Delta Reserve Business', 'AMEX', '#3E2A78', '#7D6AB2', '#FFFFFF', '["delta reserve business"]', 'exact', 1, datetime('now'), datetime('now')),
  ('amex_marriott_bonvoy_business', 'Marriott', 'Bonvoy Business', 'AMEX', '#5E2430', '#B58B6B', '#FFFFFF', '["bonvoy business amex","marriott bonvoy business"]', 'exact', 1, datetime('now'), datetime('now')),
  ('amex_marriott_bonvoy_brilliant', 'Marriott', 'Bonvoy Brilliant', 'AMEX', '#5E2430', '#B58B6B', '#FFFFFF', '["marriott bonvoy brilliant","bonvoy brilliant"]', 'exact', 1, datetime('now'), datetime('now'));
