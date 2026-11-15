# Cybertrace Check-in

QR check-in for Cybertrace club events. Participants register through a Google Form, get an email with a QR code and a 6-letter backup code, and HR members scan them in from their phones. Every action is logged with the staff member who did it.

- **Stack:** Next.js 15 (App Router) + TypeScript + Tailwind, Postgres (`pg`), Nodemailer → Gmail SMTP, `qrcode`, `html5-qrcode`, Google Apps Script.
- **Spec:** [`SPEC.md`](SPEC.md). Differences from the spec are listed at the end of this file.

```
src/lib/checkin.ts      ← all scan / check-in logic (one module, ready for an offline queue in v2)
src/lib/attendees.ts    ← form ingestion (idempotent), walk-ins, search, email fixes
src/lib/email.ts        ← QR email (CID inline image), Gmail SMTP or DEV_EMAIL_MODE=log
src/app/api/**          ← API routes (section 7 of the spec)
src/app/{login,scan,search,walkin,recent,admin}  ← pages
migrations/*.sql        ← database schema
apps-script/Code.gs     ← Google Form → API bridge with retry
tests/*.test.ts         ← required tests (run against local Postgres)
```

---

## 1. Run locally

You need **Node 20.12+** (22 recommended) and **Docker**.

```bash
npm install

# 1) Postgres 16 in docker (creates databases "cybertrace" and "cybertrace_test")
docker compose up -d db

# 2) Environment: .env.local is git-ignored. If it's missing:
cp .env.example .env.local
#    then in .env.local set:
#      DATABASE_URL=postgres://postgres:postgres@localhost:5432/cybertrace
#      DATABASE_SSL=disable
#      DEV_EMAIL_MODE=log
#      APP_BASE_URL=http://localhost:3000

# 3) Create the tables
npm run migrate

# 4) Create the first admin (6-digit PIN)
npm run seed:admin -- --name "Amyyn" --pin 123456

# 5) Start the app
npm run dev        # http://localhost:3000
```

Log in as Amyyn, open **Admin → + New event**, give it today's date as a day, and you can test everything.

**Emails in development.** With `DEV_EMAIL_MODE=log` no email is sent. Each "sent" email is printed to the console and saved to `./dev-emails/` as `…-qr.png` + `….html` (open the HTML in a browser to see exactly what the attendee would get). You can test the whole flow without the Gmail app password.

**Fake a form submission** (what the Apps Script sends). Copy the event's slug and secret from Admin → Events → your event:

```bash
curl -X POST http://localhost:3000/api/form-submit \
  -H "Content-Type: application/json" \
  -H "X-Form-Secret: <FORM_SECRET>" \
  -d '{"event_slug":"<slug>","response_id":"test-1","full_name":"Test Person","email":"test@example.com","phone":"","class_year":"","team_name":""}'
```

**Camera on a phone.** Browsers only open the camera on `https://` (or `localhost`). To scan from a real phone during development, deploy a preview to Vercel or use an HTTPS tunnel. On a laptop, `http://localhost:3000/scan` works with the webcam.

### Tests, typecheck, build

```bash
docker compose up -d db
npm test            # 41 tests, against the cybertrace_test database (recreated on each run)
npm run typecheck
npm run build
```

The tests cover everything in spec section 12: the 20-parallel-scan race (exactly 1 OK, 19 ALREADY), idempotent form posts (sequential and parallel), same email twice, multi-day, wrong event, the 150-attendee / 4-scanner load test, PIN lockout (including parallel guessing), and the CSV columns. They also cover undo rules, walk-ins, resend/fix email, failed-email retry, roles, and the backup list.

Tests use `postgres://postgres:postgres@localhost:5432/cybertrace_test` by default. Override it with `TEST_DATABASE_URL`.

---

## 2. Placeholders you must replace

`.env.example` lists every variable. Locally they go in `.env.local`. In production they go in **Vercel → Project → Settings → Environment Variables**. Anything still starting with `REPLACE_ME` is a placeholder.

| Variable | Needed in production? | Where to get it |
|---|---|---|
| `DATABASE_URL` | **Yes** | Supabase → your project → **Connect** (top bar) → **Transaction pooler**. Copy the URI (port **6543**), e.g. `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres`, and replace `[YOUR-PASSWORD]` with the database password. If you've forgotten the password, reset it under Project Settings → Database. If the password has special characters, URL-encode them. |
| `DATABASE_SSL` | optional | Leave `no-verify` (default: encrypted, certificate not pinned). For full verification, download the CA from Supabase → Project Settings → Database → SSL, put the PEM in `DATABASE_CA_CERT`, and set `verify`. |
| `PG_POOL_MAX` | optional | `5` is fine on Vercel. |
| `GMAIL_USER` | already set | `cybertrace.issatso@gmail.com` |
| `GMAIL_APP_PASSWORD` | **Yes** | Sign in to the club Gmail. Turn on **2-Step Verification** (Google Account → Security), then go to <https://myaccount.google.com/apppasswords>, create an app password named "Cybertrace check-in", and copy the 16 characters (spaces don't matter). This is not the normal Gmail password. |
| `DEV_EMAIL_MODE` | **must be empty** | Leave it empty in production so real emails are sent. Use `log` only locally. |
| `SESSION_SECRET` | **Yes** | Run `openssl rand -base64 48` (or `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`). Changing it logs everyone out. The app refuses to run on Vercel production with the placeholder. |
| `APP_BASE_URL` | **Yes** | Your Vercel URL, e.g. `https://cybertrace-checkin.vercel.app` (no trailing slash). It must start with `https://` so session cookies get the `Secure` flag. |
| `SUPABASE_URL` | no (unused) | Supabase → Project Settings → API → Project URL. Kept because the spec lists it; the code doesn't read it (see Deviations). |
| `SUPABASE_SERVICE_ROLE_KEY` | no (unused) | Supabase → Project Settings → API → `service_role` key. Same note. If you don't need it, leave it out of Vercel. One less secret to leak. |

Checklist:

- [ ] Supabase project created; `DATABASE_URL` (transaction pooler) set in Vercel
- [ ] `npm run migrate` run once against Supabase (see section 3)
- [ ] First admin seeded against Supabase
- [ ] `GMAIL_APP_PASSWORD` created and set in Vercel
- [ ] `SESSION_SECRET` generated and set in Vercel
- [ ] `APP_BASE_URL` set to the real `https://…vercel.app` URL
- [ ] `DEV_EMAIL_MODE` **not** set in Vercel production
- [ ] Each event's Apps Script has `API_URL`, `EVENT_SLUG` and `FORM_SECRET` (section 4)

---

## 3. Deploy to Vercel

1. **Supabase.** Create a project at <https://supabase.com> (pick an EU region, close to Tunisia). Copy the Transaction pooler connection string (see the table above).
2. **Create the tables in Supabase** from your computer. Use the same pooler string, or the "Session pooler" string (port 5432), which is better for migrations:
   ```bash
   DATABASE_URL="postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres" npm run migrate
   DATABASE_URL="…same…" npm run seed:admin -- --name "Amyyn" --pin <your PIN>
   ```
   The migration enables Row Level Security on every table with **no policies** and revokes access from the `anon` and `authenticated` roles, so Supabase's public API (anon key) can read nothing. The app connects as the database owner through `DATABASE_URL`, which RLS doesn't restrict.
3. **Vercel.** Push this repo to GitHub, then go to <https://vercel.com/new> → import the repo. The framework is detected as Next.js; keep the defaults (`npm run build`).
4. In **Settings → Environment Variables**, add `DATABASE_URL`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `SESSION_SECRET` and `APP_BASE_URL` (optionally `DATABASE_SSL`, `PG_POOL_MAX`). Do **not** add `DEV_EMAIL_MODE`.
5. Deploy. Open `https://<your-app>.vercel.app`, log in, create the event, then connect its form (section 4).
6. **Region (recommended):** in Settings → Functions, set the region near your Supabase region (e.g. Frankfurt `fra1`), so each query doesn't cross the Atlantic.
7. **On the phones:** open the URL in Safari (iPhone) → Share → *Add to Home Screen*, or in Chrome (Android) → ⋮ → *Install app / Add to Home screen*. Allow camera access the first time you open **Scan**.

Before each event: Admin → Emails → make sure nothing is failed. The night before, open **Backup list (print / PDF)** and print it or "Save as PDF".

---

## 4. Connect a new Google Form for a new event

Do this once per event.

1. **Create the event in the app:** Admin → Events → **+ New event**. Name, slug (e.g. `mini-ctf-2026`), location, and one row per day (date + label such as "Day 1"). Open the event card: the **Google Form connection** section shows `API_URL`, `EVENT_SLUG` and `FORM_SECRET`, each with a Copy button.
2. **Create the Google Form** (with the club Google account) with these questions. The titles must match exactly (case doesn't matter):
   - `Full name`: short answer, required
   - `Email`: short answer, required (Response validation → Text → Email is a good idea)
   - `Phone`: short answer
   - `Class / Year`: short answer or dropdown
   - `Team name`: short answer, optional

   Alternatively, turn on Settings → Responses → *Collect email addresses*. The script uses the `Email` question first and falls back to the collected address.
3. **Open the script editor:** in the form, click ⋮ (top right) → **Script editor** (Apps Script). Delete the sample code and paste the entire content of [`apps-script/Code.gs`](apps-script/Code.gs). Save (💾) and name the project, e.g. "Cybertrace check-in".
4. **Script Properties:** ⚙️ **Project Settings** (left bar) → **Script Properties** → *Add script property*, three times:
   | Property | Value |
   |---|---|
   | `API_URL` | `https://<your-app>.vercel.app/api/form-submit` |
   | `EVENT_SLUG` | the event's slug |
   | `FORM_SECRET` | the event's secret (Admin → Show / Copy) |
5. **Install the triggers:** back in **Editor**, pick `setup` in the function dropdown → **Run**. Google asks for permissions the first time ("Review permissions" → choose the club account → *Advanced* → *Go to … (unsafe)* → *Allow*). This is normal for your own script. `setup` installs:
   - an **on form submit** trigger → `onFormSubmit`
   - a **time-driven, every 5 minutes** trigger → `retryPending`

   It then runs `testConnection`. The execution log must say **`OK — API reachable, event slug and secret accepted.`** A `401` means the slug or secret is wrong.
6. **Test:** submit the form once yourself. Within seconds you should get the QR email, and the person appears in Search.
7. **Responses submitted before setup?** Run `syncAll` once. It re-sends every response. This is safe: the API ignores response ids it already has, so nobody gets a second email.

**How the reliability works:** if a POST fails (network error, Vercel down, any non-2xx), the response id goes into a pending list in Script Properties. `retryPending` runs every 5 minutes and re-sends it until it succeeds. Run `showPending` to see what's waiting, and `retryPending` to retry right away. Registrations are never lost: the form keeps the responses, and the API is idempotent.

**If you regenerate the secret** (Admin → Regenerate secret), paste the new value into `FORM_SECRET`. Until you do, submissions fail, queue up, and go through on the next retry after you fix it.

---

## How things work (short reference)

- **Check-in is atomic.** `/api/checkin` inserts into `checkins` inside a transaction. The partial unique index `one_checkin_per_day (attendee_id, event_day_id) WHERE undone_at IS NULL` makes Postgres reject a second active check-in, and a unique-violation becomes `ALREADY_CHECKED_IN` (with who and when). There is no select-then-insert.
- **Today** = the event day whose date is today in **Africa/Tunis**. If there is none, the scanner says "No event day today". Admins can pick a day in the dropdown on Home / Scan (remembered on that phone for the rest of the day). HR can't.
- **Duplicates:** the same `response_id` → nothing changes and no email is sent. The same email with a new response → details updated and the **same** QR re-sent.
- **Walk-ins:** any staff member. Created and checked in for today in one transaction. If an email is given, the QR is emailed too (for day 2). If that email is already registered, nothing is created and the app points to the existing person.
- **Undo:** HR can undo their own check-ins for 10 minutes (from *My recent*). Admins can undo any check-in.
- **Login:** pick your name, then enter your PIN. 5 wrong PINs lock the account for 10 minutes. Attempts are reserved atomically, so parallel guessing can't get more than 5 tries. Admins can unlock an account or reset a PIN in Admin → Staff. The session is an httpOnly, SameSite=Lax, signed JWT cookie (12 h). It is `Secure` whenever the app runs on https.
- **Emails** go out one at a time per server instance. Failures are stored (`email_status='failed'` + error). Admin → Emails → **Retry all failed**, or resend one person from Search.
- **Audit log:** every write (login, failed login, check-in, rejected scan, undo, walk-in, resend, email edit, export, event/staff changes, form submissions) is stored with its `staff_id`. See Admin → Audit log.

---

## Deviations from SPEC.md

1. **Database access uses `pg` + `DATABASE_URL` instead of the Supabase JS client with the service-role key** (as you asked). `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are in `.env.example` but the code doesn't read them. RLS is still enabled on every table with no policies, and the migration also revokes table access from `anon`/`authenticated`.
2. **Backup list is a printable HTML page** (`/api/events/:id/backup`, print CSS, "Print / Save as PDF" button) instead of a server-generated PDF (as you asked). `/api/events/:id/backup.pdf` still exists and redirects there.
3. **Added a `form_submissions` table** (event_id, response_id → attendee). `attendees.form_response_id` only holds one id, so without this table re-posting the *second* response of a duplicate email (e.g. via `syncAll`) would re-send the email every time. With it, every response id is idempotent.
4. **Added `attendees.updated_at`**, used to detect emails stuck in `pending` (retried after 10 minutes).
5. **Extra routes** the pages needed: `GET /api/auth/me`, `GET /api/checkin/recent`, `GET /api/admin/emails`, `/api/admin/events/:id/days[/:dayId]`. Check-in, manual check-in and walk-in also accept an optional `event_day_id`, which is honored **only for admins** (the spec's "let an admin pick a day manually").
6. **Inactive events** reject check-ins with HTTP 409. Form submissions to an inactive event are still accepted, so no registration is lost.
7. **CSV** has the required columns plus `short_code`, `email_status`, `registered_at` and a per-day `method` column. Times are Africa/Tunis. The file has a UTF-8 BOM so Excel shows accents and Arabic correctly, and cells that look like spreadsheet formulas are neutralised.
8. **Session cookie `Secure` flag** is dropped only when `APP_BASE_URL` starts with `http://` (local development over plain http). On Vercel it is always set.
9. **Added `DEV_EMAIL_MODE`, `DEV_EMAIL_DIR`, `DATABASE_SSL`, `DATABASE_CA_CERT`, `PG_POOL_MAX`** environment variables.
10. **Service worker** (`public/sw.js`) is registered but does no caching. v1 is online-only by design, and the worker is the hook for the v2 offline queue.
