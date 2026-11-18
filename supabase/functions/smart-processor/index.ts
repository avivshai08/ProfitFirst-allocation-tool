// Supabase Edge Function "smart-processor": daily reminder emails ("הגיע הזמן לבצע את החלוקה שלך").
// Called once a day by the scheduled job, which must send the x-cron-secret header
// (06_reminders_schedule.sql). Same schedule rules as before; in addition it skips clients
// who have no access (switched off, subscription ended, or signed up but not yet paid).
// Reads the database and calls bright-function with the service role key, so it keeps
// working after the cutover (03), when the public key can no longer read clients.
// Secrets: PF_CRON_SECRET. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.

const env = (name: string) => (Deno.env.get(name) ?? '').trim();

const DAY_NAMES: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};
const GRACE_DAYS: Record<string, number> = { weekly: 6, biweekly: 13, monthly: 25, twicemonthly: 12 };
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

/** Is today a reminder day for this client (unchanged rules). */
export function isDue(client: any, now: Date): boolean {
  const freq = client.reminder_frequency || 'biweekly';
  const reminderDay = client.reminder_day || 'sunday';
  const reminderDates = (client.reminder_dates || '1,15').split(',').map((d: string) => parseInt(d.trim()));
  if (freq === 'weekly' || freq === 'biweekly') return now.getDay() === (DAY_NAMES[reminderDay] ?? 0);
  if (freq === 'monthly' || freq === 'twicemonthly') return reminderDates.includes(now.getDate());
  return false;
}

/** The client may use the tool now: not switched off, not awaiting payment, end date not passed. */
export function hasAccess(client: any, now: Date): boolean {
  if (client.active === false || client.awaiting_payment === true) return false;
  return !client.subscription_end || new Date(client.subscription_end) > now;
}

export async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (!env('PF_CRON_SECRET') || req.headers.get('x-cron-secret') !== env('PF_CRON_SECRET')) {
    return reply({ error: 'forbidden' }, 403);
  }
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const headers = { apikey: key, Authorization: 'Bearer ' + key };
  try {
    const now = new Date();
    const results: any[] = [];

    // All clients with reminders enabled and an email set
    const res = await fetch(url + '/rest/v1/clients?reminder_enabled=eq.true&email=neq.&select=*', { headers });
    if (!res.ok) throw new Error('clients: HTTP ' + res.status + ' ' + (await res.text()));
    const clients = await res.json();

    for (const client of clients) {
      if (!client.email || !isDue(client, now)) continue;
      if (!hasAccess(client, now)) {
        results.push({ client: client.name, status: 'skipped - no active subscription' });
        continue;
      }

      // Skip if they already made an allocation within the grace period
      const grace = GRACE_DAYS[client.reminder_frequency || 'biweekly'] || 13;
      const cutoff = new Date(now.getTime() - grace * 24 * 60 * 60 * 1000);
      const allocRes = await fetch(
        url + '/rest/v1/allocations?client_id=eq.' + client.id + '&created_at=gt.' + cutoff.toISOString() + '&select=id&limit=1',
        { headers },
      );
      if (!allocRes.ok) throw new Error('allocations: HTTP ' + allocRes.status);
      const recentAllocs = await allocRes.json();
      if (recentAllocs.length > 0) {
        results.push({ client: client.name, status: 'skipped - recent allocation' });
        continue;
      }

      const emailRes = await fetch(url + '/functions/v1/bright-function', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'reminder', to: client.email, clientName: client.name }),
      });
      const emailData = await emailRes.json();
      results.push({ client: client.name, status: emailRes.ok ? 'sent' : 'failed', response: emailData });
    }

    return reply({ processed: results.length, results });
  } catch (err) {
    return reply({ error: String(err) }, 500);
  }
}

if (import.meta.main) Deno.serve(handle);
