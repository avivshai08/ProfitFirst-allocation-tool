# Google sign-in and online subscription: runbook

Goal: clients sign in with Google and see exactly the data they have today; new users can
sign up and pay online (SUMIT, 25 ₪ + VAT a month, first 30 days free). Completely separate
from MoneySystem: its own Google sign-in app, SUMIT product, users and access. No existing
row is changed or deleted at any step.

How existing clients are recognised: on their first Google sign-in, the database looks for
the client row whose **login email** (set by the admin) or, if that is empty, **contact
email** (`clients.email`) equals their Google email, and links that Google account to the
row (`clients.user_id`). From then on the link is by account, not by email. A Google account
that matches no client gets the signup screen instead.

## Files

| File | What it does | Changes the live site? |
|------|--------------|------------------------|
| `00_inspect.sql` | Read-only check of tables, access rules, jobs, clients missing an email | No |
| `01_backup.sql` | Copies the three tables into a private `pf_backup` schema | No |
| `02_prepare.sql` | Adds empty `user_id`, `login_email`; admin list (aviv.shai08@gmail.com); sign-in functions | No |
| `04_billing.sql` | Adds empty billing columns; signup function | No |
| `functions/pf-billing/` | Edge Function: confirms payments, cancels, daily SUMIT check, signup/cancel emails, admin's invite and "סיים מנוי" | No |
| `tools/build-pf-billing-single.cjs` | Builds `pf-billing-single.ts`, the one file pasted into the dashboard editor (`node supabase/tools/build-pf-billing-single.cjs`) | No |
| `03a_signed_in_rules.sql` | Adds the rules for Google-signed-in users (admin sees all, client only own) next to the open ones, so the new site can be tried before the switch | No |
| `03_cutover.sql` | Switches access rules to per-user (the moment of the switch) | **Yes** |
| `03_rollback.sql` | Puts the access rules back exactly as before 03 | Yes (back to old) |
| `05_billing_schedule.sql` | Daily run of the SUMIT check | No |
| `functions/smart-processor/` | Daily reminder emails: service key (works after 03), scheduler-only, skips clients without access | No |
| `06_reminders_schedule.sql` | Same 07:00 reminder job, now sending the scheduler secret | No |
| `07_renewal.sql` | Adds empty columns for renewal and the access-ended email; a list of fingerprints (sha256 of sign-in email and phone, never the values) of everyone who has been a client, filled from the existing clients, so the free month is given once per person; signup now says whether the free month applies and refuses a phone that belongs to another profile | No |
| `08_orders_notice.sql` | Adds one empty column: which live standing orders the admin was already emailed about (so that email is sent once) | No |
| `functions/bright-function/` | Emails: a client can only send their own confirmation; key in a secret; content escaped | Yes — deploy at the cutover |
| `functions/_previous/` | The two email functions as they were, for undo | — |

## Steps

1. **Inspect** — done (2026-11-18): 11 clients, 76 allocations; uuid ids; three "anon full access" policies; one daily job calling `smart-processor` with the public key.
2. **Backup** — run `01_backup.sql`; also Table Editor → Export each of `clients`, `allocations`, `settings` as CSV and keep the files.
3. **Google sign-in (you)** — create a **new Google Cloud project** for the tool (its own name and logo on Google's sign-in screen, separate from MoneySystem):
   - OAuth consent screen: External; app name; support email; home page `https://app.profitfirst.finance`; privacy policy `https://app.profitfirst.finance/privacy.html`; terms `https://app.profitfirst.finance/terms.html`; authorized domain `profitfirst.finance`; publish.
   - Credentials → OAuth client ID → Web application. Authorized redirect URI: `https://wmqgzcxwukyiahsxtupf.supabase.co/auth/v1/callback`.
   - Supabase → Authentication → Providers → Google: paste client ID and secret, enable. Turn **off** the Email provider.
   - Supabase → Authentication → URL Configuration: Site URL `https://app.profitfirst.finance`; Redirect URLs: `https://app.profitfirst.finance/**` and `http://localhost:8080/**`.
4. **Database additions** — run `02_prepare.sql`, then `04_billing.sql`. The live site keeps working.
5. **Billing function** — done 2026-11-18: deployed from the dashboard as `pf-billing` (one file: `emails.ts` + `logic.ts` + `index.ts` combined; to update it, run `node supabase/tools/build-pf-billing-single.cjs` and paste `supabase/pf-billing-single.ts` over the function's code, then Deploy); Supabase gave it the address `/functions/v1/quick-task`, which the page and `05_billing_schedule.sql` use. Secrets (Edge Functions → Secrets):
   - `SUMIT_COMPANY_ID`, `SUMIT_API_KEY` — the same SUMIT account as MoneySystem (SUMIT → Developers → API keys);
   - `PF_SUMIT_ITEM_ID` — `2003256952` (found 2026-11-18): the ID of the tool's catalog item in SUMIT (only that item's standing orders count, so a MoneySystem subscription never opens the tool and is never cancelled by it). To find it, run in PowerShell with your company ID and API key: `$b=@{Credentials=@{CompanyID=<מספר חברה>;APIKey='<API key>'};Paging=@{StartIndex=0;PageSize=100}}|ConvertTo-Json -Depth 3; (Invoke-RestMethod -Method Post -Uri https://api.sumit.co.il/accounting/incomeitems/list/ -ContentType 'application/json' -Body $b).Data.IncomeItems | Format-Table ID,Name,Price`;
   - `PF_CRON_SECRET` — any long random text (also goes into `05_billing_schedule.sql` and `06_reminders_schedule.sql`);
   - `RESEND_API_KEY` — a **new** Resend key (Resend → API Keys → Create). The old one was pasted in chat on 2026-11-18; delete it in Resend after step 10.
   - `PF_DELETE_EXPIRED` — leave unset at first: the daily run then only lists in pf-billing → Logs (`retention: … due [names]`) who would be deleted. Set it to `on` once that list looks right; from then on clients are deleted 60 days after their access ended.
   After changing the code: `node supabase/tools/build-pf-billing-single.cjs`, paste `supabase/pf-billing-single.ts` over the function's code, Deploy.
6. **SUMIT (you)** — two payment pages for the same catalog item (2003256952): "מערכת ניהול חלוקות (לקוח חדש)" `…/17ia2el/x4oqyg/payment/` (first charge after 30 days: new signups, once per person) and "מערכת ניהול חלוקות" `…/x4oqsu/x4oqyg/payment/` (first charge at once: renewal, fixing a failed payment, anyone who already had the free month). On **both** set "כתובת לניווט לאחר ביצוע התשלום" and "כתובת לניווט לאחר קבלת הזמנה ללא חיוב" to `https://app.profitfirst.finance/`.
   Then run `07_renewal.sql` and `08_orders_notice.sql` (after `04_billing.sql`; safe before or after the cutover), and only then deploy the pf-billing version that reads their columns.
7. **Reminders** — replace the code of `smart-processor` with `functions/smart-processor/index.ts` and deploy, then at once run `06_reminders_schedule.sql` (not around 07:00 UTC). Works with the old site too, and keeps working after the cutover.
8. **Try it on prod without switching anything** — run `03a_signed_in_rules.sql` first (without it a signed-in admin sees no clients, because before the cutover only the public key has access rules). Then double-click "Test new Profit First site" on the Desktop (runs `tools/serve-local.cjs`) and use `http://localhost:8080`:
   - sign in with aviv.shai08@gmail.com → admin screen with all clients;
   - sign in with a second Google account → signup → SUMIT page → pay with a real card (no charge in the first 30 days) → back on `http://localhost:8080` press "כבר שילמתי — בדוק שוב" → you are in. Make an allocation; then profile → ביטול מנוי. Delete this test client in admin afterwards.
   The old site keeps working throughout.
9. **Clients without a usable email** — the five listed on 2026-11-18 are test/inactive clients, so nothing to do; any client added before the cutover needs a Google email as אימייל לכניסה.
10. **Cutover**, same hour: run `01_backup.sql` again with a new date suffix; publish the new site on Netlify (`index.html`, `terms.html`, `privacy.html`); run `03_cutover.sql`; replace the code of `bright-function` with `functions/bright-function/index.ts` and deploy (not earlier: the old site sends confirmations with the public key, which the new version refuses); run `05_billing_schedule.sql`. Then delete the old Resend key.
11. **Tell clients**: in admin, open each client and press **שלח מייל הצטרפות** (after the cutover, so the instructions are true). Clients who already have allocations get "sign-in moved to Google, your data is kept"; others get "you have access". It goes to their אימייל לכניסה (or else their email) and says which Google account to choose. In admin, מחובר ל־Google appears as each one signs in.

**Undo the cutover:** `03_rollback.sql`, then re-publish the old `index.html` (commit `cd7fb41`: the live site of 2026-11-18 minus unused code, plus the admin password fix). `select cron.unschedule('pf-billing-daily');` stops the daily check. Paste `functions/_previous/bright-function.ts` back into `bright-function` (the old site needs it; it reads the `RESEND_API_KEY` secret). The new `smart-processor` works with the old site, so it can stay. No data is touched by any of these.

## If a client cannot get in

- **Sees the signup screen instead of their data**: their Google email does not match. In admin, set their אימייל לכניסה to the Google email they use; they press "כניסה עם חשבון Google אחר" or sign in again.
- **"יותר מפרופיל אחד"**: two clients share that email. Give each a different אימייל לכניסה.
- **Linked to the wrong account**: in admin, נתק חשבון Google, fix the email, they sign in again. Their data is not touched.
- **Paid but still "ההרשמה כמעט הושלמה"**: the daily check retries for 7 days. The payment is found by the client's Google email, then by their phone, on whichever SUMIT card holds it. If they changed both on SUMIT's payment page, enter that card's number in admin (מספר לקוח SUMIT); the client presses "כבר שילמתי — בדוק שוב".

## Billing rules

- Access opens when SUMIT shows the tool's standing order Active, or pending its first charge (the free month).
- Failed charge: 5 more days (the tool's own rule, whatever SUMIT's retries), with a banner in the tool to update the payment; then access stops and the client gets one "access ended" email with the renewal deadline. A later successful charge restores it.
- Updating the payment, and renewing within 60 days of access ending (button on the ended screen): a new standing order on the immediate-charge page. The tool checks SUMIT when the client comes back, signs in, or presses "כבר שילמתי — בדוק שוב" (and daily), finds the new order on their card or by email, then phone, opens access at once with all their data, and cancels the old order(s) of this tool for that client.
- Old orders are cancelled only when a payment reopens access (renewal, or fixing a failed payment). A client with open access and more than one live order for the tool: nothing is cancelled; the admin gets one email (per set of orders) and decides.
- A new charge (newer than the last one seen) removes any end date, the admin's too: a manual extension never blocks a client who pays.
- Free month once per person: signup sends someone whose sign-in email or phone has been a client before to the immediate-charge page.
- 60 days after access ended (or 60 days after an unpaid signup) the daily run deletes the profile, its allocations and its Google sign-in record (only with `PF_DELETE_EXPIRED=on`). Never a client with access. Not a client SUMIT still has a live order for: the admin gets one email instead; nothing is cancelled.
- Cancel (client's ביטול מנוי, or in SUMIT): access to a month after the last payment, or to the end of the free month.
- Emails (Resend, from and to aviv@bottomline.finance for the admin): when a signup is confirmed, the client gets a welcome (with the first charge date during the free month) and the admin a new-client notice; when a subscription is cancelled (the client in the tool, or found cancelled in SUMIT by the daily check) both get one, once. A failed email is logged in pf-billing → Logs and never blocks billing.
- Clients the admin adds get no automatic email; the admin sends **שלח מייל הצטרפות** from the client card when ready (pf-billing `invite`, admin only, read from the saved details; not sent to a client without access).
- Admin's **סיים מנוי** (list ⏸ or client card) on a client with a SUMIT customer number opens a choice: end and cancel the standing order, end only (the order stays; a new charge would reopen access), or back. Through pf-billing `admin_end` (admin only); the order is cancelled only when chosen, and first, so if SUMIT fails nothing changes. No email is sent. **בדוק מול SUMIT** in the client card runs the check for that client now (`admin_check`). A client without a SUMIT number only gets today's end date. **מחק לקוח** is refused while a SUMIT-billed client has not been cancelled, so no standing order is left running without a profile.
- An end date the admin set is changed by the billing check only when a new charge comes in. Clients the admin manages by hand (no SUMIT customer number) are looked up in SUMIT only when they have no access or an end date and open the tool (a renewal); otherwise never.

## Tests

Run against a local Postgres (PGlite) with the exact production table structure and
policies: data is byte-identical after 01, 02, 04 and 03; the old site still works after 02
and 04; after 03 each client reaches only their own data, cannot open or change their own
subscription, and the admin reaches everything; signup creates exactly one closed row;
`03_rollback.sql` restores the three original policies exactly. The billing rules are
unit-tested with fake SUMIT responses (including a MoneySystem order on the same customer),
and the page is tested in a real browser with a fake Supabase and SUMIT.
