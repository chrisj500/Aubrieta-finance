-- 029: Preserve merchant category codes from providers for deterministic local categorization.
ALTER TABLE transactions ADD COLUMN merchant_category_code TEXT;
CREATE INDEX idx_transactions_mcc ON transactions(merchant_category_code);
