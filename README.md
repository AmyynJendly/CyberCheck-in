# Cybertrace Check-in

QR check-in for Cybertrace club events. Participants register through a Google Form, get an email with a QR code and a 6-letter backup code, and HR members scan them in from their phones. Every action is logged with the staff member who did it.

- **Stack:** Next.js 15 (App Router) + TypeScript + Tailwind, Postgres (`pg`), Nodemailer → Gmail SMTP, `qrcode`, `html5-qrcode`, Google Apps Script.
- **Spec:** [`SPEC.md`](SPEC.md). Differences from the spec are listed at the end of this file.
- **Hosting, stability and the event-day checklist:** [`HOSTING.md`](HOSTING.md).

**Two interfaces.** HR members get the check-in app: **Scan**, **Search**, **Add Person** (name, email, phone), plus *My Check-ins* to undo a mistake. Admins also get the **admin dashboard** (`/admin`): Overview (today's seats, cash, emails, per-session table with a CSV per day), People (everyone and their check-ins), Cash, Emails (QR email template, sending queue, paste registrations), Members, Activity (audit log), Staff and Events.

```
src/lib/checkin.ts      ← all scan / check-in logic (one module, ready for an offline queue in v2)
src/lib/attendees.ts    ← form ingestion (idempotent), walk-ins, search, email fixes
src/lib/email.ts        ← QR email template + single-sender queue, Gmail SMTP or DEV_EMAIL_MODE=log
src/app/api/**          ← API routes (section 7 of the spec)
src/app/{login,scan,search,walkin,recent}  ← the HR app
src/app/admin/**        ← the admin dashboard
scripts/loadtest.ts     ← load test against the deployed app (HOSTING.md)
migrations/*.sql        ← database schema
apps-script/Code.gs     ← Google Form → API bridge with retry
tests/*.test.ts         ← required tests (run against local Postgres)
```

---

## 1. Run locally

> **No Docker?** You can point `DATABASE_URL` in `.env.local` at your Supabase project instead (see section 3) and skip `docker compose`. Everything works the same, except `npm test`: the tests delete and rebuild their database, so they refuse to run against anything but a local database.


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
npm test            # 81 tests, against the cybertrace_test database (recreated on each run)
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
- [ ] After deploy: `https://<your-app>.vercel.app/api/health` returns `{"ok":true,"db":"up"}`, and the daily cron job appears under Vercel → Settings → Cron Jobs

---

## 3. Deploy to Vercel

1. **Supabase.** Create a project at <https://supabase.com> (region: West EU (Ireland), `eu-west-1`, to match the Vercel functions in Dublin). Copy the Transaction pooler connection string (see the table above).
2. **Create the tables in Supabase** from your computer. Use the same pooler string, or the "Session pooler" string (port 5432), which is better for migrations:
   ```bash
   DATABASE_URL="postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres" npm run migrate
   DATABASE_URL="…same…" npm run seed:admin -- --name "Amyyn" --pin <your PIN>
   ```
   The migration enables Row Level Security on every table with **no policies** and revokes access from the `anon` and `authenticated` roles, so Supabase's public API (anon key) can read nothing. The app connects as the database owner through `DATABASE_URL`, which RLS doesn't restrict.
3. **Vercel.** Push this repo to GitHub, then go to <https://vercel.com/new> → import the repo. The framework is detected as Next.js; keep the defaults (`npm run build`).
4. In **Settings → Environment Variables**, add `DATABASE_URL`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `SESSION_SECRET` and `APP_BASE_URL` (optionally `DATABASE_SSL`, `PG_POOL_MAX`). Do **not** add `DEV_EMAIL_MODE`.
5. Deploy. Open `https://<your-app>.vercel.app`, log in, create the event, then connect its form (section 4).
6. **Region:** `vercel.json` pins the functions to Dublin (`dub1`). Create Supabase in West EU (Ireland, `eu-west-1`) too, so each query stays in the same region. See [`HOSTING.md`](HOSTING.md) for why this matters and for the load test to run before each event.
7. **On the phones:** open the URL in Safari (iPhone) → Share → *Add to Home Screen*, or in Chrome (Android) → ⋮ → *Install app / Add to Home screen*. Allow camera access the first time you open **Scan**.

**Keeping Supabase awake.** Supabase's free tier pauses a project after about a week without activity, which is normal between club events. While it's paused, form submissions fail. They queue in the Apps Script and go through later, so nothing is lost, but emails are delayed. To prevent this, `vercel.json` defines a **Vercel cron job** that calls `GET /api/health` once a day (04:17 UTC). The endpoint reads from the `events` table, so the database sees real activity every day. Nothing to configure: Vercel picks it up on deploy (Project → Settings → Cron Jobs shows it). `https://<your-app>.vercel.app/api/health` is also a quick status check: `{"ok":true,"db":"up"}`, or HTTP 503 if the database is unreachable.

> Supabase doesn't publish exactly what counts as "activity". A daily query is the usual way to keep a project awake, but check the project status in the Supabase dashboard a week after deploying. Either way, before you open registration for an event, confirm in Supabase that the project is running (if it was paused, click **Restore**).

**Volunteer guide.** `https://<your-app>.vercel.app/hr-guide.html` is a one-page quick guide for HR volunteers: logging in, what each result colour means, and what to do when something goes wrong. It's linked from the home screen and needs no login (it contains no secrets). Print it from a laptop browser (one A4 page), fill in the app address and the admin's name and phone, and leave a copy at each desk. The source is `public/hr-guide.html`.

Before each event, follow the checklist in [`HOSTING.md`](HOSTING.md): health check, load test, test email, nothing failed in Admin → Emails, backup list printed.

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

## Paid days and membership (bootcamp format)

Each event day has an **entry rule**, set in Admin → Events → (event) → Days:

| Rule | Who gets in free | Everyone else |
|---|---|---|
| Free for everyone | everyone | — |
| Members only | club members | must **join the club** (the event's membership fee, 15 DT by default) |
| Members free, others pay | club members | pay the day's **entry fee** (5 DT by default), or join the club |

Example, the bootcamp: Session 1 *Free for everyone*; Sessions 2–4 *Members only*; Competition *Members free, others pay*, 5 DT.

- **Member list** (Admin → Members): copy the rows from Excel or Google Sheets, including the header row (name, email, phone; French headers like *Nom et prénom*, *Téléphone* work too), and paste them. Press **Preview**, check the rows, then **Import**. Importing again updates people instead of duplicating them. For screenshots of a list, give them to Claude to turn into rows you can paste.
- **Who counts as a member:** someone on the list whose membership hasn't expired, matched by **email**, or by **phone** (last 8 digits). If a person registered with a different email, HR can use Search → *Member? Find on List* to link them by hand.
- **Membership lasts the academic year:** it ends on 31 August by default (you can change the date when importing). Joining at the desk makes someone a member until then, so every later day, including the competition, is free.
- **At the door:** a non-member on a paid day gets a blue **Payment needed** screen (scanner, Search and Walk-in all work the same). HR takes the cash first, then taps **Paid 15 DT · Join the club** or **Paid 5 DT · Entry only**. The payment and the check-in are saved together, in one database transaction, under that staff member's name. If they don't pay, they aren't checked in.
- **"Already a member, not on the list":** a third choice on the payment screen. The person is let in as a member with **no money recorded**; it's saved under the HR member's name, and the membership goes to **Admin → Members → To check**, where an admin confirms it or rejects it (rejected → they're asked to pay next time). The Overview shows how many are waiting.
- **The registration stand:** before the event, people register on the Google Form at the stand and may pay there. Paste the stand's sheet in **Admin → People → Import sheet**. The app recognises the columns (name, email, phone, the "enrolled in" checkbox, paid) and what each checkbox answer means — check or change both before importing. **Paid + the sessions = the membership (15 DT)**: free for every session and the main event. **Paid + the main event only = the main-event entry (5 DT)**. A number in the Paid column decides directly (15 → membership, 5 → entry). Rows marked paid with no clear enrollment are listed and not recorded. People missing from the app are added and get their QR email; people who already got it aren't emailed again. Re-importing the same sheet changes nothing. Stand money is shown separately from door cash.
- **Selling the membership outside the door** (e.g. during the free first session): Admin → People → tap the person → *Paid 15 DT · Join the club* (or *Paid 5 DT · main-event entry*, or *Is a member · no payment*). HR can't do this; it's admin-only.
- **Enrollment:** the form's "what do you enroll in" checkbox is stored and shown in People. The Apps Script finds the first checkbox question; to use another one, set the Script Property `ENROLLMENT_QUESTION` to its exact title.
- **Cash** (Admin → Cash): what each staff member collected, today or for all days, and every payment. HR members see their own total for the day on their home screen. Only admins can cancel a payment entered by mistake (tap it). A membership bought with a cancelled payment is removed too. The check-in stays; undo it separately if needed.
- **Exports:** the CSV adds `member_until` plus `paid` / `paid_to` columns per day; the backup list adds a *Member* column. The QR email explains each day's rule.

## Seats, emails and exports

- **Seats per day:** Admin → Events → (event) → Days → *Seats* (empty = no limit). Bootcamp: Session 1 → 80, Sessions 2–4 → 60, Competition → 120. The database enforces it (a trigger takes a seat per check-in and refuses when full), so no combination of phones can oversell. When a session is full the scanner shows **Session Full** before anyone pays. Undo frees the seat. The limit is on check-ins (people in the room), not on registrations: compare *Registered* with the seats on the Overview to decide when to close the Google Form.
- **QR email template:** Admin → Emails. Plain text with placeholders `{{name}}`, `{{qr}}`, `{{code}}`, `{{event}}`, `{{dates}}`, `{{location}}`, `{{entry}}`. A live preview shows exactly what people receive; *Send Test Email* sends it to you. The QR and the backup code are always included, even if the template leaves them out. *Reset to Default* restores the built-in text.
- **Sending:** every registration is queued and sent by one sender at a time over a single Gmail connection (Gmail blocks bursts). Temporary Gmail errors leave the email *waiting* and it's retried automatically (after each registration, and every 5 minutes by the form's script); after 5 failed tries it's marked *failed*. Admin → Emails shows both, with *Send Waiting Now* and *Retry Failed*.
- **Paste registrations:** Admin → Emails → *Add registrations by pasting* (name, email, phone with a header row, e.g. from the Google Form's response sheet). Everyone with an email gets their QR. Pasting the same list again changes nothing.
- **CSV per session:** Admin → Overview → *CSV* on each day's row: the people checked in that day, with time, staff member and payment. *Full CSV* has everyone and every day. CSV and the backup list are admin-only.

## Design

The interface follows Apple's dark-mode design language: the system font (SF Pro on iPhone and Mac; Roboto or Segoe UI elsewhere), iOS system colors, grouped inset lists, translucent bars, a passcode-style PIN pad and bottom sheets for confirmations. Icons are [Lucide](https://lucide.dev).

- **Brand color:** one token, `--color-accent` (plus `--color-on-accent` for text on filled buttons), at the top of `src/app/globals.css`. Change it there to re-theme the whole app. The QR email (`src/lib/email.ts`), backup list (`src/lib/backup.ts`) and desk guide (`public/hr-guide.html`) use a darker version, `#0a7f94`, on white.
- **Scan results** use Apple's high-contrast green, orange and red (`--color-ok-deep`, `--color-warn-deep`, `--color-bad-deep`), readable with white text at a glance.
- **Text styles** (`t-large`, `t-title2`, `t-body`, `t-footnote`…) mirror the iOS type scale and are defined in the same file.

## How things work (short reference)

- **Check-in is atomic.** `/api/checkin` inserts into `checkins` in a single statement (with the seat count and audit entry). The partial unique index `one_checkin_per_day (attendee_id, event_day_id) WHERE undone_at IS NULL` makes Postgres reject a second active check-in, and a unique-violation becomes `ALREADY_CHECKED_IN` (with who and when). There is no select-then-insert.
- **Today** = the event day whose date is today in **Africa/Tunis**. If there is none, the scanner says "No event day today". Admins can pick a day in the dropdown on Home / Scan (remembered on that phone for the rest of the day). HR can't.
- **Duplicates:** the same `response_id` → nothing changes and no email is sent. The same email with a new response → details updated and the **same** QR re-sent.
- **Walk-ins ("Add Person"):** any staff member; full name required, email and phone optional. Created and checked in for today in one transaction. If an email is given, the QR is emailed too (for day 2). If that email is already registered, nothing is created and the app points to the existing person.
- **Undo:** HR can undo their own check-ins for 10 minutes (from *My recent*). Admins can undo any check-in.
- **Login:** pick your name, then enter your PIN. 5 wrong PINs lock the account for 10 minutes. Attempts are reserved atomically, so parallel guessing can't get more than 5 tries. Admins can unlock an account or reset a PIN in Admin → Staff. The session is an httpOnly, SameSite=Lax, signed JWT cookie (12 h). It is `Secure` whenever the app runs on https.
- **Emails** go through the single-sender queue (see *Seats, emails and exports*). Resend from Search sends right away.
- **Audit log:** every write (login, failed login, check-in, rejected scan, undo, walk-in, resend, email edit, export, event/staff changes, form submissions) is stored with its `staff_id`. See Admin → Activity.

---

## Deviations from SPEC.md

1. **Database access uses `pg` + `DATABASE_URL` instead of the Supabase JS client with the service-role key** (as you asked). `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are in `.env.example` but the code doesn't read them. RLS is still enabled on every table with no policies, and the migration also revokes table access from `anon`/`authenticated`.
2. **Backup list is a printable HTML page** (`/api/events/:id/backup`, print CSS, "Print / Save as PDF" button) instead of a server-generated PDF (as you asked). `/api/events/:id/backup.pdf` still exists and redirects there.
3. **Added a `form_submissions` table** (event_id, response_id → attendee). `attendees.form_response_id` only holds one id, so without this table re-posting the *second* response of a duplicate email (e.g. via `syncAll`) would re-send the email every time. With it, every response id is idempotent.
4. **Added `attendees.updated_at`**, used to detect emails stuck in `pending` (retried after 10 minutes).
5. **Extra routes** the pages needed: `GET /api/health` (public status check, called daily by the Vercel cron in `vercel.json` to keep Supabase awake), `GET /api/auth/me`, `GET /api/checkin/recent`, `GET /api/admin/emails`, `/api/admin/events/:id/days[/:dayId]`. Check-in, manual check-in and walk-in also accept an optional `event_day_id`, which is honored **only for admins** (the spec's "let an admin pick a day manually").
6. **Inactive events** reject check-ins with HTTP 409. Form submissions to an inactive event are still accepted, so no registration is lost.
7. **CSV** has the required columns plus `short_code`, `email_status`, `registered_at` and a per-day `method` column. Times are Africa/Tunis. The file has a UTF-8 BOM so Excel shows accents and Arabic correctly, and cells that look like spreadsheet formulas are neutralised.
8. **Session cookie `Secure` flag** is dropped only when `APP_BASE_URL` starts with `http://` (local development over plain http). On Vercel it is always set.
9. **Added `DEV_EMAIL_MODE`, `DEV_EMAIL_DIR`, `DATABASE_SSL`, `DATABASE_CA_CERT`, `PG_POOL_MAX`** environment variables.
10. **Membership and paid entry** (not in the original spec; added for the bootcamp): `members` and `payments` tables, `event_days.access` / `entry_fee` and `events.membership_fee` columns (migration `002_membership_payments.sql`), routes `POST /api/checkin/pay`, `GET /api/events/:id/payments`, `POST /api/admin/payments/:id/void`, `/api/admin/members` (+ `/import`, `/:id`), `GET /api/members/search`, `POST /api/attendees/:id/member`, and a new scan result `PAYMENT_REQUIRED`. The QR code itself is unchanged: one code per person, once per day.
11. **Seats, two interfaces, email queue** (added for stability and the bootcamp): migrations `003` (seat limit, email template columns, email attempts, job leases) and `004` (seat counter + trigger); CSV, backup list and payments are **admin-only** (the spec let HR export); new admin routes `/api/admin/events/:id/{overview,people,import,email-preview,email-test}`, `/api/admin/emails/send`; `/api/events/:id/export.csv?day_id=` for one session; scan result `FULL`; the form-submit endpoint also accepts `{event_slug, ping: true}` (from the Apps Script trigger) to nudge the email queue.
12. **Claims, stand sheet, enrollment** (bootcamp): migration `005` (member `needs_review` and sources `claimed`/`stand`, payments `channel` desk/stand and optional day, attendee `enrollment` + flags); `kind: "claim"` on `/api/checkin/pay` and `payment: "claim"` on `/api/walkin`; `/api/admin/events/:id/import` now reads the stand sheet with column/answer mapping; `POST /api/admin/attendees/:id/payment`; `GET /api/admin/members/review`, `POST /api/admin/members/:id/review`; the form-submit payload accepts `enrollment`.
13. **Service worker** (`public/sw.js`) is registered but does no caching. v1 is online-only by design, and the worker is the hook for the v2 offline queue.
