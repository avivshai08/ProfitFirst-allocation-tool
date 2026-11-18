// Supabase Edge Function "bright-function": the tool's emails, sent through Resend.
//   - A signed-in client (their own sign-in token): {type:"confirmation", income, results, date}
//     → sent to the email stored on their own client profile, only if allocation emails are on.
//     The recipient and name in the request are ignored, so nobody can send mail to others.
//   - Internal callers (the service role key, i.e. smart-processor): {type:"reminder", to, clientName}.
// Everything put into the email is HTML-escaped. Email texts and design are unchanged.
// Secrets: RESEND_API_KEY. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.

const env = (name: string) => (Deno.env.get(name) ?? '').trim();
const FROM = 'Bottom Line <aviv@bottomline.finance>';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function fmtMoney(n: number): string {
  return '&#8362;' + Math.round(n).toLocaleString('en-US');
}

type Recipient = { to: string; clientName: string };

/** The signed-in user's own client profile (by their token), or null. */
async function ownClient(token: string): Promise<{ name: string; email: string; notify_alloc: boolean | null } | null> {
  const service = env('SUPABASE_SERVICE_ROLE_KEY');
  const userRes = await fetch(env('SUPABASE_URL') + '/auth/v1/user', { headers: { apikey: service, Authorization: 'Bearer ' + token } });
  if (!userRes.ok) return null;
  const user = await userRes.json();
  if (!user?.id) return null;
  const rowsRes = await fetch(
    env('SUPABASE_URL') + '/rest/v1/clients?user_id=eq.' + encodeURIComponent(user.id) + '&select=name,email,notify_alloc',
    { headers: { apikey: service, Authorization: 'Bearer ' + service } },
  );
  if (!rowsRes.ok) return null;
  const rows = await rowsRes.json();
  return rows[0] ?? null;
}

function confirmationHtml(clientName: string, income: unknown, results: any[], date: unknown) {
  const rows = (Array.isArray(results) ? results : []).map((r: any) =>
    `<tr>
          <td style="padding:8px 14px;border-bottom:1px solid #eee;text-align:right;font-size:13px;">${esc(r.name)}</td>
          <td style="padding:8px 14px;border-bottom:1px solid #eee;text-align:left;font-size:13px;direction:ltr;">${fmtMoney(Number(r.amount))}</td>
          <td style="padding:8px 14px;border-bottom:1px solid #eee;text-align:left;font-size:13px;">${Number(r.pct).toFixed(1)}%</td>
        </tr>`
  ).join('');
  const incomeFormatted = fmtMoney(Number(income));
  return `
        <!DOCTYPE html>
        <html dir="rtl" lang="he">
        <body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
          <div style="max-width:520px;margin:30px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
            <div style="background:#5BC8C0;padding:18px 24px;">
              <h2 style="color:#1A1A1A;margin:0;font-size:18px;">Bottom Line - Profit First</h2>
              <p style="color:#1A1A1A;margin:4px 0 0;font-size:12px;opacity:.7;">אישור חלוקה</p>
            </div>
            <div style="padding:24px;">
              <p style="font-size:14px;color:#333;margin:0 0 6px;">שלום ${esc(clientName)},</p>
              <p style="font-size:14px;color:#333;margin:0 0 16px;">החלוקה שלך לתאריך <strong>${esc(date)}</strong> נשמרה בהצלחה.</p>
              <div style="background:#E8F8F7;border-radius:8px;padding:10px 14px;margin-bottom:16px;display:inline-block;">
                <span style="font-size:12px;color:#3A9E97;">סך הכנסות:</span>
                <span style="font-size:16px;font-weight:700;color:#1A1A1A;margin-right:8px;direction:ltr;display:inline-block;">${incomeFormatted}</span>
              </div>
              <table style="width:100%;border-collapse:collapse;margin-top:4px;">
                <thead>
                  <tr style="background:#E8F8F7;">
                    <th style="padding:8px 14px;text-align:right;color:#3A9E97;font-size:12px;font-weight:600;">חשבון</th>
                    <th style="padding:8px 14px;text-align:left;color:#3A9E97;font-size:12px;font-weight:600;">סכום</th>
                    <th style="padding:8px 14px;text-align:left;color:#3A9E97;font-size:12px;font-weight:600;">אחוז</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
              <p style="font-size:11px;color:#aaa;margin-top:24px;padding-top:16px;border-top:1px solid #eee;">
                Bottom Line - Adding Value &nbsp;|&nbsp;
                <a href="mailto:aviv@bottomline.finance" style="color:#5BC8C0;text-decoration:none;">aviv@bottomline.finance</a>
              </p>
            </div>
          </div>
        </body>
        </html>`;
}

function reminderHtml(clientName: string) {
  return `
        <!DOCTYPE html>
        <html dir="rtl" lang="he">
        <body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
          <div style="max-width:520px;margin:30px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
            <div style="background:#5BC8C0;padding:18px 24px;">
              <h2 style="color:#1A1A1A;margin:0;font-size:18px;">Bottom Line - Profit First</h2>
            </div>
            <div style="padding:24px;">
              <p style="font-size:14px;color:#333;margin:0 0 12px;">שלום ${esc(clientName)},</p>
              <p style="font-size:14px;color:#333;margin:0 0 16px;">הגיע הזמן לבצע את החלוקה שלך!</p>
              <a href="https://app.profitfirst.finance" style="display:inline-block;background:#5BC8C0;color:#1A1A1A;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">כניסה לכלי</a>
              <p style="font-size:11px;color:#aaa;margin-top:24px;padding-top:16px;border-top:1px solid #eee;">
                Bottom Line - Adding Value &nbsp;|&nbsp;
                <a href="mailto:aviv@bottomline.finance" style="color:#5BC8C0;text-decoration:none;">aviv@bottomline.finance</a>
              </p>
            </div>
          </div>
        </body>
        </html>`;
}

export async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const body = await req.json();
    const internal = token !== '' && token === env('SUPABASE_SERVICE_ROLE_KEY');

    let recipient: Recipient;
    if (internal) {
      if (body.type !== 'reminder' && body.type !== 'confirmation') return reply({ error: 'unknown type' }, 400);
      recipient = { to: String(body.to ?? ''), clientName: String(body.clientName ?? '') };
    } else {
      if (body.type !== 'confirmation') return reply({ error: 'forbidden' }, 403);
      const client = await ownClient(token);
      if (!client) return reply({ error: 'not signed in' }, 401);
      if (!client.email || client.notify_alloc === false) return reply({ skipped: true });
      recipient = { to: client.email, clientName: client.name };
    }
    if (!recipient.to) return reply({ error: 'no recipient' }, 400);

    const subject = body.type === 'confirmation' ? `אישור חלוקה - ${String(body.date ?? '')}` : 'תזכורת - זמן לבצע חלוקה';
    const html = body.type === 'confirmation'
      ? confirmationHtml(recipient.clientName, body.income, body.results, body.date)
      : reminderHtml(recipient.clientName);

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: recipient.to, subject, html }),
    });
    const data = await res.json();
    return reply(data, res.ok ? 200 : 400);
  } catch (err) {
    return reply({ error: String(err) }, 500);
  }
}

if (import.meta.main) Deno.serve(handle);
