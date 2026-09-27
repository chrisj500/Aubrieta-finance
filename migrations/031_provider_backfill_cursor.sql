-- 031: Independent historical-backfill cursor so older imports never disturb forward sync.
ALTER TABLE provider_connections ADD COLUMN backfill_cursor TEXT;
