// The billing emails: to the client when their signup is confirmed and when their
// subscription is cancelled, and to the admin about both. Same look as bright-function's
// emails. Pure functions (subject + HTML), so they can be tested without sending.

export const FROM = 'Bottom Line <aviv@bottomline.finance>';
/** Where the admin's notifications go (not the admin's Google sign-in address). */
export const ADMIN_EMAIL = 'aviv@bottomline.finance';
const TOOL_URL = 'https://app.profitfirst.finance';

export type Email = { to: string; subject: string; html: string };
export type EmailClient = { name: string; email: string; login_email: string | null; phone?: string | null; sumit_customer_id: string | null };

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** YYYY-MM-DD → DD.MM.YYYY */
export function heDate(iso: string | null) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

/** The client's contact email, or the Google email they signed up with. */
export function clientAddress(c: EmailClient) {
  return (c.email || c.login_email || '').trim();
}

const P = 'font-size:14px;color:#333;margin:0 0 12px;line-height:1.7;';
const p = (html: string) => `<p style="${P}">${html}</p>`;
const button = `<a href="${TOOL_URL}" style="display:inline-block;background:#5BC8C0;color:#1A1A1A;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">כניסה לכלי</a>`;

function layout(body: string) {
  return `
        <!DOCTYPE html>
        <html dir="rtl" lang="he">
        <body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
          <div style="max-width:520px;margin:30px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
            <div style="background:#5BC8C0;padding:18px 24px;">
              <h2 style="color:#1A1A1A;margin:0;font-size:18px;">Bottom Line - Profit First</h2>
            </div>
            <div style="padding:24px;">
              ${body}
              <p style="font-size:11px;color:#aaa;margin-top:24px;padding-top:16px;border-top:1px solid #eee;">
                Bottom Line - Adding Value &nbsp;|&nbsp;
                <a href="mailto:aviv@bottomline.finance" style="color:#5BC8C0;text-decoration:none;">aviv@bottomline.finance</a>
              </p>
            </div>
          </div>
        </body>
        </html>`;
}

function details(rows: Array<[string, string]>) {
  return `<table style="border-collapse:collapse;margin:0 0 12px;">${rows
    .map(([k, v]) => `<tr><td style="padding:4px 0 4px 16px;color:#888;font-size:13px;">${esc(k)}</td><td style="padding:4px 0;font-size:14px;color:#1A1A1A;">${v}</td></tr>`)
    .join('')}</table>`;
}
const ltr = (v: unknown) => `<span dir="ltr">${esc(v)}</span>`;

/** To the client, once their signup is confirmed. firstCharge is set during the free month. */
export function welcomeEmail(c: EmailClient, firstCharge: string | null): Email {
  const billing = firstCharge
    ? p(`30 הימים הראשונים ללא תשלום. החיוב הראשון יתבצע ב־<strong>${heDate(firstCharge)}</strong>, ולאחר מכן פעם בחודש.`)
      + p(`ביטול לפני ${heDate(firstCharge)} לא יחויב כלל.`)
    : p('המנוי החודשי שלך פעיל.');
  return {
    to: clientAddress(c),
    subject: 'ההרשמה לכלי לחלוקת הכנסות הושלמה',
    html: layout(
      p(`שלום ${esc(c.name)},`)
      + p('ההרשמה שלך לכלי לחלוקת הכנסות של Bottom Line הושלמה, והכלי פתוח לשימושך.')
      + billing
      + (c.login_email ? p(`הכניסה לכלי היא עם חשבון ה־Google ${ltr(c.login_email)}.`) : '')
      + p('אפשר לבטל את המנוי בכל עת: הגדרות פרופיל ← ביטול מנוי.')
      + button,
    ),
  };
}

/** To the client, once their subscription is cancelled. */
export function cancelledEmail(c: EmailClient, accessUntil: string | null): Email {
  return {
    to: clientAddress(c),
    subject: 'אישור ביטול מנוי',
    html: layout(
      p(`שלום ${esc(c.name)},`)
      + p('המנוי שלך לכלי לחלוקת הכנסות בוטל, ולא יבוצעו חיובים נוספים.')
      + (accessUntil ? p(`הגישה לכלי תימשך עד <strong>${heDate(accessUntil)}</strong>.`) : '')
      + p('אם לא ביקשת לבטל, או שיש לך שאלה, אפשר להשיב למייל הזה.'),
    ),
  };
}

/** To the admin: a new paid (or free-month) signup. */
export function adminSignupEmail(c: EmailClient, firstCharge: string | null): Email {
  return {
    to: ADMIN_EMAIL,
    subject: `לקוח חדש נרשם: ${c.name}`,
    html: layout(
      p('לקוח חדש נרשם לכלי לחלוקת הכנסות, והתשלום אושר ב־SUMIT.')
      + details([
        ['שם', esc(c.name)],
        ['אימייל לכניסה', ltr(c.login_email ?? '')],
        ...(c.email && c.email !== c.login_email ? [['אימייל', ltr(c.email)] as [string, string]] : []),
        ...(c.phone ? [['טלפון', ltr(c.phone)] as [string, string]] : []),
        ['חיוב ראשון', firstCharge ? `${heDate(firstCharge)} (חודש ללא תשלום)` : 'כבר בוצע'],
        ...(c.sumit_customer_id ? [['מספר לקוח SUMIT', ltr(c.sumit_customer_id)] as [string, string]] : []),
      ]),
    ),
  };
}

/** To the admin: a cancellation, by the client in the tool or found in SUMIT by the daily check. */
export function adminCancelledEmail(c: EmailClient, accessUntil: string | null, by: 'client' | 'sumit'): Email {
  return {
    to: ADMIN_EMAIL,
    subject: `ביטול מנוי: ${c.name}`,
    html: layout(
      p(by === 'client' ? 'הלקוח ביטל את המנוי מתוך הכלי.' : 'הוראת הקבע של הלקוח בוטלה ב־SUMIT (זוהה בבדיקה היומית).')
      + details([
        ['שם', esc(c.name)],
        ['אימייל', ltr(clientAddress(c))],
        ['גישה עד', accessUntil ? heDate(accessUntil) : 'ללא תאריך סיום'],
        ...(c.sumit_customer_id ? [['מספר לקוח SUMIT', ltr(c.sumit_customer_id)] as [string, string]] : []),
      ]),
    ),
  };
}
