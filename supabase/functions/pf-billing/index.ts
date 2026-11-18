// Supabase Edge Function "pf-billing": the allocation tool's SUMIT billing.
//   {action:"confirm"} — signed-in client: open access once SUMIT shows their order (after payment)
//   {action:"cancel"}  — signed-in client: cancel their standing order (ביטול מנוי)
//   {action:"daily"}   — scheduled job (header x-cron-secret): see logic.ts runDaily
// Secrets (Supabase → Edge Functions → Secrets): SUMIT_COMPANY_ID, SUMIT_API_KEY,
// PF_SUMIT_ITEM_ID (this tool's catalog item in SUMIT), PF_CRON_SECRET.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
import { createClient } from 'npm:@supabase/supabase-js@2.119.0';
import {
  cancelSubscription,
  type ClientRow,
  type Clients,
  confirmSignup,
  type RecurringItem,
  runDaily,
  STATUS,
  type Sumit,
  type SumitCustomer,
} from './logic.ts';

const env = (name: string) => (Deno.env.get(name) ?? '').trim();
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

/** SUMIT documents enums by name with the number in brackets; accept either form. */
function enumNumber(value: unknown, names: Record<string, number>): number | null {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return null;
  const bracketed = /\((\d+)\)/.exec(value);
  if (bracketed) return Number(bracketed[1]);
  if (/^\d+$/.test(value)) return Number(value);
  return names[value] ?? null;
}
const isoDate = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

async function sumitCall<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch('https://api.sumit.co.il' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Credentials: { CompanyID: Number(env('SUMIT_COMPANY_ID')), APIKey: env('SUMIT_API_KEY') }, ...body }),
  });
  if (!res.ok) throw new Error(`SUMIT ${path}: HTTP ${res.status}`);
  const json = await res.json();
  if (enumNumber(json.Status, { Success: 0 }) !== 0) {
    throw new Error(`SUMIT ${path}: ${json.UserErrorMessage ?? json.TechnicalErrorDetails ?? 'unknown error'}`);
  }
  return json.Data as T;
}
const customerRef = (c: SumitCustomer) =>
  'externalId' in c ? { ExternalIdentifier: c.externalId, SearchMode: 2 } : { ID: Number(c.customerId), SearchMode: 1 };

const sumit: Sumit = {
  async list(customer, includeInactive) {
    const data = await sumitCall<{ RecurringItems?: Array<Record<string, any>> | null }>(
      '/billing/recurring/listforcustomer/',
      { Customer: customerRef(customer), IncludeInactive: includeInactive },
    );
    return (data?.RecurringItems ?? []).map((item): RecurringItem => ({
      id: Number(item.ID),
      itemId: item.Item?.ID != null ? Number(item.Item.ID) : null,
      status: enumNumber(item.Status, STATUS) ?? -1,
      firstBilling: isoDate(item.Date_Start),
      previousBilling: isoDate(item.Date_PreviousBilling),
    }));
  },
  async cancel(customer, recurringItemId) {
    await sumitCall('/billing/recurring/cancel/', { Customer: customerRef(customer), RecurringCustomerItemID: recurringItemId });
  },
};

const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
const COLUMNS = 'id,name,email,signup_source,sumit_customer_id,awaiting_payment,subscription_end,sumit_end_date,subscription_cancelled_at,created_at';
async function rows(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<ClientRow[]> {
  const { data, error } = await query;
  if (error) throw new Error(JSON.stringify(error));
  return (data ?? []) as ClientRow[];
}
const clients: Clients = {
  async byUserId(userId) {
    return (await rows(db.from('clients').select(COLUMNS).eq('user_id', userId).limit(1)))[0] ?? null;
  },
  pendingSince(isoDate) {
    return rows(db.from('clients').select(COLUMNS).eq('awaiting_payment', true).gte('created_at', isoDate));
  },
  billed() {
    return rows(
      db.from('clients').select(COLUMNS).eq('awaiting_payment', false)
        .or('signup_source.eq.self,sumit_customer_id.not.is.null'),
    );
  },
  async update(id, values) {
    const { error } = await db.from('clients').update(values).eq('id', id);
    if (error) throw new Error(JSON.stringify(error));
  },
};

/** Today in Israel, YYYY-MM-DD. */
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const productItemId = Number(env('PF_SUMIT_ITEM_ID'));
  if (!env('SUMIT_COMPANY_ID') || !env('SUMIT_API_KEY') || !productItemId) return reply({ error: 'not_configured' }, 503);
  const deps = { clients, sumit, productItemId };
  let action = '';
  try { action = (await req.json()).action; } catch { /* empty body */ }

  try {
    if (action === 'daily') {
      if (!env('PF_CRON_SECRET') || req.headers.get('x-cron-secret') !== env('PF_CRON_SECRET')) return reply({ error: 'forbidden' }, 403);
      return reply(await runDaily(today(), deps));
    }
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: auth } = await db.auth.getUser(jwt);
    if (!auth?.user) return reply({ error: 'not_signed_in' }, 401);
    const row = await clients.byUserId(auth.user.id);
    if (!row) return reply({ error: 'no_client' }, 404);
    if (action === 'confirm') return reply({ opened: await confirmSignup(row, deps) });
    if (action === 'cancel') return reply(await cancelSubscription(row, today(), deps));
    return reply({ error: 'unknown_action' }, 400);
  } catch (e) {
    console.error(`pf-billing ${action}:`, e);
    return reply({ error: 'failed' }, 500);
  }
});
