-- Replaces the daily reminder job (job 3, 07:00 UTC, calls smart-processor) with the same
-- job that also sends the x-cron-secret header, so only the scheduler can trigger reminders.
-- Run right after deploying the new smart-processor (not around 07:00 UTC).
-- Replace PASTE_PF_CRON_SECRET with the PF_CRON_SECRET function secret.
-- Undo: unschedule 'pf-reminders-daily' and schedule the old command again (shown in 00_inspect).

select cron.unschedule(3);

select cron.schedule('pf-reminders-daily', '0 7 * * *', $$
  select net.http_post(
    url := 'https://wmqgzcxwukyiahsxtupf.supabase.co/functions/v1/smart-processor',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndtcWd6Y3h3dWt5aWFoc3h0dXBmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4Mzg5NzMsImV4cCI6MjA4OTQxNDk3M30.m0B5Qqbsn5cWggotBWLklvKVzAxWKIIMzbMsf0lK7co", "x-cron-secret": "PASTE_PF_CRON_SECRET"}'::jsonb,
    body := '{}'::jsonb
  );
$$);

select jobid, jobname, schedule from cron.job order by jobid;
