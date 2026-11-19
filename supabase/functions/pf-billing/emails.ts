// The billing emails: to the client when their signup is confirmed, when their
// subscription is cancelled or their access ends (with the renewal deadline), and to the
// admin. Same look as bright-function's emails. Pure functions (subject + HTML), so they
// can be tested without sending.

import { KEEP_DAYS } from './logic.ts';

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

const renewBy = (endDate: string) => {
  const d = new Date(`${endDate.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + KEEP_DAYS);
  return d.toISOString().slice(0, 10);
};
/** "Renew by <date>, after that the data is deleted", for the cancellation and access-ended emails. */
function renewalNote(endDate: string | null) {
  return endDate
    ? p(`אפשר לחדש את המנוי עד <strong>${heDate(renewBy(endDate))}</strong>, ולהמשיך עם כל הנתונים שלך: נכנסים לכלי ובוחרים "חידוש מנוי". לאחר תאריך זה החשבון והנתונים יימחקו.`)
    : p(`אפשר לחדש את המנוי עד ${KEEP_DAYS} יום לאחר סיום הגישה, ולהמשיך עם כל הנתונים שלך: נכנסים לכלי ובוחרים "חידוש מנוי". לאחר מכן החשבון והנתונים יימחקו.`);
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
      + renewalNote(accessUntil)
      + p('אם לא ביקשת לבטל, או שיש לך שאלה, אפשר להשיב למייל הזה.'),
    ),
  };
}

/** To the client, when access ended without a cancellation (the payment did not go through). */
export function endedEmail(c: EmailClient, endDate: string): Email {
  return {
    to: clientAddress(c),
    subject: 'הגישה לכלי לחלוקת הכנסות הסתיימה',
    html: layout(
      p(`שלום ${esc(c.name)},`)
      + p(`החיוב החודשי לא עבר, ולכן הגישה לכלי לחלוקת הכנסות הסתיימה ב־<strong>${heDate(endDate)}</strong>.`)
      + renewalNote(endDate)
      + p('בחידוש מזינים אמצעי תשלום, והגישה נפתחת מיד.')
      + button,
    ),
  };
}

/** To the admin: due for deletion, but SUMIT still shows a live standing order, so not deleted. */
export function adminHeldEmail(c: EmailClient, endDate: string): Email {
  return {
    to: ADMIN_EMAIL,
    subject: `לא נמחק: ${c.name} (הוראת קבע פעילה ב־SUMIT)`,
    html: layout(
      p(`עברו ${KEEP_DAYS} יום מסיום הגישה של הלקוח, אבל ב־SUMIT עדיין יש לו הוראת קבע פעילה לכלי, ולכן הוא לא נמחק.`)
      + p('אם הלקוח לא אמור להיות מחויב, בטל את הוראת הקבע ב־SUMIT, והלקוח יימחק בבדיקה היומית הבאה. אם הוא אמור לקבל גישה, פתח לו את המנוי בכרטיס הלקוח.')
      + details([
        ['שם', esc(c.name)],
        ['אימייל', ltr(clientAddress(c))],
        ['סיום גישה', heDate(endDate)],
        ...(c.sumit_customer_id ? [['מספר לקוח SUMIT', ltr(c.sumit_customer_id)] as [string, string]] : []),
      ]),
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

/** To the admin: a client with open access has more than one live standing order for the tool. */
export function adminDuplicateOrdersEmail(c: EmailClient, customerId: string, orderIds: number[]): Email {
  return {
    to: ADMIN_EMAIL,
    subject: `שתי הוראות קבע פעילות: ${c.name}`,
    html: layout(
      p('ללקוח יש יותר מהוראת קבע פעילה אחת לכלי ב־SUMIT, ולכן הוא עלול להיות מחויב פעמיים. הכלי לא ביטל דבר.')
      + p('בדוק ב־SUMIT ובטל את ההוראה המיותרת. ההודעה הזו נשלחת פעם אחת לכל מצב כזה.')
      + details([
        ['שם', esc(c.name)],
        ['אימייל', ltr(clientAddress(c))],
        ['מספר לקוח SUMIT', ltr(customerId)],
        ['הוראות קבע', ltr(orderIds.join(', '))],
      ]),
    ),
  };
}

/** The address a client signs in with: their login email, or else their contact email. */
export function signInAddress(c: Pick<EmailClient, 'email' | 'login_email'>) {
  return (c.login_email || c.email || '').trim();
}

/**
 * To a client the admin added, sent from admin with "שלח מייל הצטרפות": how to get in with
 * Google. A client who already used the tool (returning) is told that sign-in moved to Google.
 */
export function inviteEmail(c: EmailClient, accessUntil: string | null, returning: boolean): Email {
  const address = signInAddress(c);
  const li = (html: string) => `<li style="margin-bottom:6px;">${html}</li>`;
  return {
    to: address,
    subject: returning ? 'הכניסה לכלי לחלוקת הכנסות עוברת ל־Google' : 'הוזמנת לכלי לחלוקת הכנסות של Bottom Line',
    html: layout(
      p(`שלום ${esc(c.name)},`)
      + (returning
        ? p('הכניסה לכלי לחלוקת הכנסות של Bottom Line היא מעכשיו עם חשבון Google, במקום שם וסיסמה. כל הנתונים וההקצאות שלך נשמרו.')
        : p('נפתחה עבורך גישה לכלי לחלוקת הכנסות של Bottom Line.'))
      + p('<strong>איך נכנסים:</strong>')
      + `<ol style="${P}padding-right:20px;">`
      + li(`נכנסים ל־<a href="${TOOL_URL}" style="color:#3A9E97;">app.profitfirst.finance</a>`)
      + li('לוחצים על <strong>כניסה עם Google</strong>')
      + li(`בוחרים את חשבון ה־Google ${ltr(address)}`)
      + '</ol>'
      + (accessUntil ? p(`הגישה פתוחה עד <strong>${heDate(accessUntil)}</strong>.`) : '')
      + p('אם אין לך חשבון Google בכתובת הזו, אפשר להשיב למייל הזה עם הכתובת שבה נוח לך להיכנס, ונעדכן אותה.')
      + button,
    ),
  };
}
