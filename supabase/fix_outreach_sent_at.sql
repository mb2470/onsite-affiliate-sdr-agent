-- Fix outreach_log.sent_at: all rows have NULL because inserts never set it.
-- This breaks every dashboard query that filters on sent_at.

-- 1. Backfill NULL sent_at from created_at (if the column exists) or NOW()
UPDATE outreach_log
SET sent_at = COALESCE(created_at, NOW())
WHERE sent_at IS NULL;

-- 2. Add DEFAULT NOW() so future inserts without sent_at still get a value
ALTER TABLE outreach_log
  ALTER COLUMN sent_at SET DEFAULT NOW();
