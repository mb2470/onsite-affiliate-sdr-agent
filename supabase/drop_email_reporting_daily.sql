-- Drop the email_reporting_daily table and its RPC function.
-- This table was a write-only rollup that no dashboard ever read from.
-- All email metrics come from outreach_log + activity_log directly.

DROP FUNCTION IF EXISTS public.increment_email_reporting_daily(UUID, DATE, INTEGER, INTEGER, INTEGER);
DROP INDEX IF EXISTS idx_email_reporting_daily_org_date;
DROP TABLE IF EXISTS public.email_reporting_daily;
