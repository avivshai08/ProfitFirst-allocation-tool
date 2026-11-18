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
| `functions/pf-billing/` | Edge Function: confirms payments, cancels, daily SUMIT check | No |
| `03_cutover.sql` | Switches access rules to per-user (the moment of the switch) | **Yes** |
| `03_rollback.sql` | Puts the access rules back exactly as before 03 | Yes (back to old) |
| `05_billing_schedule.sql` | Daily run of the SUMIT check | No |

## Steps

1. **Inspect** — done (2026-11-18): 11 clients, 76 allocations; uuid ids; three "anon full access" policies; one daily job calling `smart-processor` with the public key.
2. **Backup** — run `01_backup.sql`; also Table Editor → Export each of `clients`, `allocations`, `settings` as CSV and keep the files.
3. **Google sign-in (you)** — create a **new Google Cloud project** for the tool (its own name and logo on Google's sign-in screen, separate from MoneySystem):
   - OAuth consent screen: External; app name; support email; home page = the tool's address; privacy policy = `<tool address>/privacy.html`; terms = `<tool address>/terms.html`; publish.
   - Credentials → OAuth client ID → Web application. Authorized redirect URI: `https://wmqgzcxwukyiahsxtupf.supabase.co/auth/v1/callback`.
   - Supabase → Authentication → Providers → Google: paste client ID and secret, enable. Turn **off** the Email provider.
   - Supabase → Authentication → URL Configuration: Site URL = the tool's address; Redirect URLs: the tool's address and `http://localhost:8080`.
4. **Database additions** — run `02_prepare.sql`, then `04_billing.sql`. The live site keeps working.
5. **Billing function (you, I can guide)** — Supabase → Edge Functions → Deploy a new function → via editor, name `pf-billing`, with the two files from `functions/pf-billing/`. Secrets (Edge Functions → Secrets):
   - `SUMIT_COMPANY_ID`, `SUMIT_API_KEY` — the same SUMIT account as MoneySystem (SUMIT → Developers → API keys);
   - `PF_SUMIT_ITEM_ID` — the ID of the tool's catalog item in SUMIT (only that item's standing orders count, so a MoneySystem subscription never opens the tool and is never cancelled by it);
   - `PF_CRON_SECRET` — any long random text (also goes into `05_billing_schedule.sql`).
6. **SUMIT (you)** — on the tool's payment page/item set both "כתובת לניווט לאחר ביצוע התשלום" and "כתובת לניווט לאחר קבלת הזמנה ללא חיוב" to the tool's address.
7. **Check `smart-processor`** — the daily 07:00 job calls it with the public key. If it reads `clients` with that key, it stops working at the cutover. Send me its code (Edge Functions → smart-processor → Code), and `bright-function`'s, before step 10.
8. **Try it on prod without switching anything** — in the repo folder run `npx serve -l 8080`, open `http://localhost:8080`:
   - sign in with aviv.shai08@gmail.com → admin screen with all clients;
   - sign in with a second Google account → signup → SUMIT page → pay with a real card (no charge in the first 30 days) → back on `http://localhost:8080` press "כבר שילמתי — בדוק שוב" → you are in. Make an allocation; then profile → ביטול מנוי. Delete this test client in admin afterwards.
   The old site keeps working throughout.
9. **Clients without a usable email** — set their אימייל לכניסה in the new admin screen (on localhost) to the Google email they will use.
10. **Cutover**, same hour: run `01_backup.sql` again with a new date suffix; publish the new site on Netlify (`index.html`, `terms.html`, `privacy.html`); run `03_cutover.sql`; run `05_billing_schedule.sql`.
11. **Tell clients**: "from now on, sign in with the Google account of <their email>". In admin, מחובר ל־Google appears as each one signs in.

**Undo the cutover:** `03_rollback.sql`, then re-publish the old `index.html` (commit `cd7fb41`). `select cron.unschedule('pf-billing-daily');` stops the daily check. No data is touched by any of these.

## If a client cannot get in

- **Sees the signup screen instead of their data**: their Google email does not match. In admin, set their אימייל לכניסה to the Google email they use; they press "כניסה עם חשבון Google אחר" or sign in again.
- **"יותר מפרופיל אחד"**: two clients share that email. Give each a different אימייל לכניסה.
- **Linked to the wrong account**: in admin, נתק חשבון Google, fix the email, they sign in again. Their data is not touched.
- **Paid but still "ההרשמה כמעט הושלמה"**: the daily check retries for 7 days. If SUMIT filed the payment under an existing customer card (e.g. someone who is also a MoneySystem customer), enter that card's number in admin (מספר לקוח SUMIT); the client presses "כבר שילמתי — בדוק שוב".

## Billing rules (same as MoneySystem)

- Access opens when SUMIT shows the tool's standing order Active, or pending its first charge (the free month).
- Failed charge: 5 more days, then access stops; a later successful charge restores it.
- Cancel (client's ביטול מנוי, or in SUMIT): access to a month after the last payment, or to the end of the free month.
- An end date the admin set is never changed by the billing check. Clients the admin manages by hand (no online signup, no SUMIT customer number) are never sent to SUMIT.

## Tests

Run against a local Postgres (PGlite) with the exact production table structure and
policies: data is byte-identical after 01, 02, 04 and 03; the old site still works after 02
and 04; after 03 each client reaches only their own data, cannot open or change their own
subscription, and the admin reaches everything; signup creates exactly one closed row;
`03_rollback.sql` restores the three original policies exactly. The billing rules are
unit-tested with fake SUMIT responses (including a MoneySystem order on the same customer),
and the page is tested in a real browser with a fake Supabase and SUMIT.
