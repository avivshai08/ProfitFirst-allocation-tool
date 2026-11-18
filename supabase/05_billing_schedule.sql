-- Runs the daily SUMIT check (pf-billing, action "daily") at 06:00 UTC (08:00/09:00 Israel),
-- the same way the existing reminder job calls its function. Run after the pf-billing
-- function is deployed and its secrets are set.
-- Replace PASTE_PF_CRON_SECRET with the same value as the PF_CRON_SECRET function secret.
-- Undo: select cron.unschedule('pf-billing-daily');

select cron.schedule('pf-billing-daily', '0 6 * * *', $$
  select net.http_post(
    url := 'https://wmqgzcxwukyiahsxtupf.supabase.co/functions/v1/pf-billing',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndtcWd6Y3h3dWt5aWFoc3h0dXBmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4Mzg5NzMsImV4cCI6MjA4OTQxNDk3M30.m0B5Qqbsn5cWggotBWLklvKVzAxWKIIMzbMsf0lK7co", "x-cron-secret": "PASTE_PF_CRON_SECRET"}'::jsonb,
    body := '{"action": "daily"}'::jsonb
  );
$$);
