// Supabase Edge Function "pf-billing": the allocation tool's SUMIT billing.
//   {action:"confirm"} — signed-in client: open access once SUMIT shows their order (after payment)
//   {action:"cancel"}  — signed-in client: cancel their standing order (ביטול מנוי)
//   {action:"daily"}   — scheduled job (header x-cron-secret): see logic.ts runDaily
//   {action:"invite", clientId} — admin only: "שלח מייל הצטרפות" to a client (how to sign in)
// Secrets (Supabase → Edge Functions → Secrets): SUMIT_COMPANY_ID, SUMIT_API_KEY,
// PF_SUMIT_ITEM_ID (this tool's catalog item in SUMIT), PF_CRON_SECRET, RESEND_API_KEY (the
// signup and cancellation emails, see emails.ts; without it billing still works, unannounced).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
import { createClient } from 'npm:@supabase/supabase-js@2.119.0';
import {
  cancelSubscription,
  type ClientRow,
  type Clients,
  confirmSignup,
  type Notify,
  type RecurringItem,
  runDaily,
  STATUS,
  type Sumit,
  type SumitCustomer,
} from './logic.ts';
import {
  adminCancelledEmail,
  adminSignupEmail,
  cancelledEmail,
  type Email,
  FROM,
  inviteEmail,
  signInAddress,
  welcomeEmail,
} from './emails.ts';

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
// By customer number only: a search by external identifier creates an empty card when
// nothing matches. The customers/list lookups below only read.
const customerRef = (c: SumitCustomer) => ({ ID: Number(c.customerId), SearchMode: 1 });
async function customerIds(filter: { EmailAddress: string } | { PhoneNumber: string }, label: string) {
  const data = await sumitCall<{ Customers?: Array<Record<string, any>> | null }>(
    '/accounting/customers/list/',
    { ...filter, Paging: { StartIndex: 0, PageSize: 20 } },
  );
  const ids = (data?.Customers ?? []).map((c) => String(c.ID)).filter((id) => /^\d+$/.test(id));
  console.log(`sumit customers by ${label}: ${ids.join(', ') || 'none'}`);
  return ids;
}

const sumit: Sumit = {
  async list(customer, includeInactive) {
    const data = await sumitCall<{ RecurringItems?: Array<Record<string, any>> | null }>(
      '/billing/recurring/listforcustomer/',
      { Customer: customerRef(customer), IncludeInactive: includeInactive },
    );
    const items = (data?.RecurringItems ?? []).map((item): RecurringItem => ({
      id: Number(item.ID),
      itemId: item.Item?.ID != null ? Number(item.Item.ID) : null,
      status: enumNumber(item.Status, STATUS) ?? -1,
      firstBilling: isoDate(item.Date_Start),
      previousBilling: isoDate(item.Date_PreviousBilling),
    }));
    // Item numbers and statuses only (no personal details), to diagnose from the Logs tab.
    console.log(`sumit list ${JSON.stringify(customer)}: ${items.map((i) => `item ${i.itemId} status ${i.status}`).join(', ') || 'none'}`);
    return items;
  },
  customerIdsByEmail: (email) => customerIds({ EmailAddress: email }, 'email'),
  customerIdsByPhone: (phone) => customerIds({ PhoneNumber: phone }, 'phone'),
  async cancel(customer, recurringItemId) {
    await sumitCall('/billing/recurring/cancel/', { Customer: customerRef(customer), RecurringCustomerItemID: recurringItemId });
  },
};

async function send(email: Email) {
  if (!email.to) throw new Error('no address');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: email.to, subject: email.subject, html: email.html }),
  });
  if (!res.ok) throw new Error(`Resend: HTTP ${res.status} ${await res.text()}`);
}
/** Sends all, then reports any that failed (one failed address does not stop the others). */
async function sendAll(emails: Email[]) {
  const failed = (await Promise.allSettled(emails.map(send))).filter((r) => r.status === 'rejected');
  if (failed.length) throw new Error(failed.map((r) => ((r as PromiseRejectedResult).reason as Error)?.message ?? String((r as PromiseRejectedResult).reason)).join('; '));
}
const notify: Notify = {
  signedUp: (row, firstCharge) => sendAll([welcomeEmail(row, firstCharge), adminSignupEmail(row, firstCharge)]),
  cancelled: (row, accessUntil, by) => sendAll([cancelledEmail(row, accessUntil), adminCancelledEmail(row, accessUntil, by)]),
};

const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
const COLUMNS = 'id,name,email,login_email,phone,signup_source,sumit_customer_id,awaiting_payment,subscription_end,sumit_end_date,subscription_cancelled_at,created_at';
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
    return rows(db.from('clients').select(COLUMNS).eq('awaiting_payment', false).not('sumit_customer_id', 'is', null));
  },
  async update(id, values) {
    const { error } = await db.from('clients').update(values).eq('id', id);
    if (error) throw new Error(JSON.stringify(error));
  },
};

/** Today in Israel, YYYY-MM-DD. */
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

/** Same rule as the database's pf_is_admin(): a verified email listed in pf_admins. */
async function isAdmin(user: { email?: string; email_confirmed_at?: string | null }) {
  if (!user.email || !user.email_confirmed_at) return false;
  const { data, error } = await db.from('pf_admins').select('email');
  if (error) throw new Error(JSON.stringify(error));
  return ((data ?? []) as Array<{ email: string }>).some((a) => a.email.toLowerCase() === user.email!.toLowerCase());
}

/** The admin's "שלח מייל הצטרפות": the client's details are read here, never taken from the page. */
async function invite(clientId: string) {
  const { data, error } = await db.from('clients')
    .select('name,email,login_email,sumit_customer_id,subscription_end,active').eq('id', clientId).limit(1);
  if (error) throw new Error(JSON.stringify(error));
  const c = (data ?? [])[0] as (ClientRow & { active: boolean | null }) | undefined;
  if (!c) return { ok: false, error: 'no_client' };
  if (!signInAddress(c)) return { ok: false, error: 'no_email' };
  const accessUntil = c.subscription_end ? c.subscription_end.slice(0, 10) : null;
  if (c.active === false || (accessUntil && accessUntil < today())) return { ok: false, error: 'no_access' };
  const used = await db.from('allocations').select('*', { count: 'exact', head: true }).eq('client_id', clientId);
  if (used.error) throw new Error(JSON.stringify(used.error));
  const email = inviteEmail(c, accessUntil, (used.count ?? 0) > 0);
  try {
    await send(email);
  } catch (e) {
    console.error(`email invite ${clientId}: ${(e as Error).message ?? e}`);
    return { ok: false, error: 'send_failed' };
  }
  return { ok: true, to: email.to };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const productItemId = Number(env('PF_SUMIT_ITEM_ID'));
  if (!env('SUMIT_COMPANY_ID') || !env('SUMIT_API_KEY') || !productItemId) return reply({ error: 'not_configured' }, 503);
  const deps = { clients, sumit, productItemId, notify };
  let body: { action?: string; clientId?: string } = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const action = String(body.action ?? '');

  try {
    if (action === 'daily') {
      if (!env('PF_CRON_SECRET') || req.headers.get('x-cron-secret') !== env('PF_CRON_SECRET')) return reply({ error: 'forbidden' }, 403);
      return reply(await runDaily(today(), deps));
    }
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: auth } = await db.auth.getUser(jwt);
    if (!auth?.user) return reply({ error: 'not_signed_in' }, 401);
    if (action === 'invite') {
      if (!(await isAdmin(auth.user))) return reply({ error: 'forbidden' }, 403);
      return reply(await invite(String(body.clientId ?? '')));
    }
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
