# Moving sign-in to Google: runbook

Goal: clients sign in with Google and see exactly the data they have today. No row is
changed or deleted at any step. Each step says who does it and how to undo it.

How existing clients are recognised: on their first Google sign-in, the database looks for
the client row whose **login email** (set by the admin) or, if that is empty, **contact
email** (`clients.email`) equals their Google email, and links that Google account to the
row (`clients.user_id`). From then on the link is by account, not by email.

## Steps

| # | Step | Who | Affects the live site? | Undo |
|---|------|-----|------------------------|------|
| 1 | Run `00_inspect.sql` (read-only) in Supabase → SQL Editor; send the results | You | No | — |
| 2 | Run `01_backup.sql`; also export `clients`, `allocations`, `settings` as CSV and keep them | You | No | — |
| 3 | Google Cloud: OAuth client (Web). Authorized redirect URI `https://wmqgzcxwukyiahsxtupf.supabase.co/auth/v1/callback`. Supabase → Authentication → Providers → Google: paste client ID/secret, enable. Turn **off** the Email provider. Authentication → URL Configuration: Site URL = the tool's address; add `http://localhost:8080` to Redirect URLs for step 5 | You | No | Disable the provider |
| 4 | Put your Google email in the last line of `02_prepare.sql`, uncomment it, run the file | You | No (adds empty columns and functions only) | — |
| 5 | Try the new page on prod data without switching anything: run `npx serve -l 8080` in the repo folder, open `http://localhost:8080`, sign in with Google → admin screen. Create a test client with a second Google email of yours, sign in with it, make an allocation | You (I can walk you through it) | No — the old site keeps working | Delete the test client |
| 6 | Fix the clients listed by query 5 of `00_inspect.sql`: set their אימייל לכניסה in the new admin screen | You | No | — |
| 7 | **Cutover**, same hour: run `01_backup.sql` again (new date suffix), publish the new `index.html` at the tool's address, run `03_cutover.sql` | You + me | Yes: old password login stops, Google login starts | `03_rollback.sql` + re-publish the old `index.html` (commit `cd7fb41`) |
| 8 | Tell clients: "from now on, sign in with the Google account of <their email>". Watch the admin list: מחובר ל־Google appears as each one signs in | You | — | — |

`03_cutover.sql` changes access rules only. After it, the public key in the page can read
nothing but the brand; each client reaches only their own row and allocation history; the
admin (email in `pf_admins`) reaches everything; a client cannot change their own
subscription, login email or Google link.

## If a client cannot get in

- **"לא נמצא פרופיל"**: their Google email does not match. In admin, set their אימייל לכניסה to the Google email they use; they sign in again.
- **"יותר מפרופיל אחד"**: two clients share that email. Give each a different אימייל לכניסה.
- **Linked to the wrong account**: in admin, נתק חשבון Google, fix the email, they sign in again. Their data is not touched.

## Tests

The SQL was run against a mock copy of the tables in a local Postgres (PGlite): data is
byte-identical after 01, 02 and 03; the old site still works after 02; after 03 every
access rule above holds; `03_rollback.sql` restores the previous rules exactly (with and
without pre-existing policies), and the cutover can be re-run after a rollback.
