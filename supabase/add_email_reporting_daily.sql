-- Daily reporting table for email metrics used by dashboard rollups.
-- This table is updated at write-time from send paths to avoid runtime undercounting.

CREATE TABLE IF NOT EXISTS public.email_reporting_daily (
  id BIGSERIAL PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  report_date DATE NOT NULL,
  sent_count INTEGER NOT NULL DEFAULT 0,
  reply_count INTEGER NOT NULL DEFAULT 0,
  bounce_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, report_date)
);

CREATE INDEX IF NOT EXISTS idx_email_reporting_daily_org_date
  ON public.email_reporting_daily (org_id, report_date DESC);

CREATE OR REPLACE FUNCTION public.increment_email_reporting_daily(
  p_org_id UUID,
  p_report_date DATE,
  p_sent_delta INTEGER DEFAULT 0,
  p_reply_delta INTEGER DEFAULT 0,
  p_bounce_delta INTEGER DEFAULT 0
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.email_reporting_daily (
    org_id,
    report_date,
    sent_count,
    reply_count,
    bounce_count
  ) VALUES (
    p_org_id,
    p_report_date,
    GREATEST(COALESCE(p_sent_delta, 0), 0),
    GREATEST(COALESCE(p_reply_delta, 0), 0),
    GREATEST(COALESCE(p_bounce_delta, 0), 0)
  )
  ON CONFLICT (org_id, report_date)
  DO UPDATE SET
    sent_count = public.email_reporting_daily.sent_count + GREATEST(COALESCE(p_sent_delta, 0), 0),
    reply_count = public.email_reporting_daily.reply_count + GREATEST(COALESCE(p_reply_delta, 0), 0),
    bounce_count = public.email_reporting_daily.bounce_count + GREATEST(COALESCE(p_bounce_delta, 0), 0),
    updated_at = now();
END;
$$;

GRANT EXECUTE ON FUNCTION public.increment_email_reporting_daily(UUID, DATE, INTEGER, INTEGER, INTEGER)
  TO anon, authenticated, service_role;
