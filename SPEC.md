# Cybertrace Check-in System — Build Spec

> Hand this file to Claude Code as the project spec. Build in the phases listed in section 10, and do not skip the tests in section 11.

## 1. Goal

A stable, reusable check-in system for Cybertrace club events (80–130 people per event, sometimes over several days).

Flow:
1. A participant fills a **Google Form** (one form per event).
2. They receive an **email from cybertrace.issatso@gmail.com** containing a **QR code** and a short backup code.
3. HR members open a **web app (PWA)** on their phones, log in with **their own PIN**, and scan the QR.
4. Every action is traceable to the HR member who did it.
5. After the event, HR downloads a **CSV**.

Version 1 is **online-only**. Offline mode comes later, so design the code so it can be added (keep scan logic in one module).

## 2. Stack

| Part | Choice | Why |
|---|---|---|
| Web app + API | Next.js (App Router) + TypeScript | One project for the scanner, admin pages and API |
| Hosting | Vercel (free) | Stable, handles traffic spikes, allows SMTP from functions |
| Database | Supabase Postgres (free) | Hosted, reliable, real SQL constraints |
| Email | Nodemailer → Gmail SMTP (`smtp.gmail.com:465`) with an **app password** | Uses the club Gmail; about 500 emails/day (Apps Script would cap at about 100/day) |
| QR generation | `qrcode` npm package (PNG buffer) | Simple |
| QR scanning | `html5-qrcode` or `@zxing/browser` | Works in Safari (iOS) and Chrome (Android) |
| Form | Google Forms + Google Apps Script (bound to the form) | No form to build |
| Styling | Tailwind CSS | Fast, mobile-first |

All database access goes through **server-side API routes** using the Supabase service-role key. Enable RLS on all tables with **no policies**, so the anon key can read nothing.

## 3. Environment variables (Vercel)

```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
GMAIL_USER=cybertrace.issatso@gmail.com
GMAIL_APP_PASSWORD=
SESSION_SECRET=            # 32+ random bytes, signs session cookies
APP_BASE_URL=              # e.g. https://cybertrace-checkin.vercel.app
```

Never commit secrets. Provide a `.env.example`.

## 4. Data model (Postgres)

```sql
events (
  id uuid pk default gen_random_uuid(),
  slug text unique not null,          -- e.g. "mini-ctf-2026"
  name text not null,
  location text,
  form_secret text not null,          -- random, shared with that event's Apps Script
  is_active boolean default true,
  created_at timestamptz default now()
)

event_days (
  id uuid pk,
  event_id uuid fk -> events,
  day_date date not null,
  label text,                         -- "Day 1", "Day 2"
  unique (event_id, day_date)
)

staff (
  id uuid pk,
  name text not null,
  pin_hash text not null,             -- bcrypt, never store plain PIN
  role text check (role in ('hr','admin')) default 'hr',
  is_active boolean default true,
  failed_attempts int default 0,
  locked_until timestamptz,
  created_at timestamptz default now()
)

attendees (
  id uuid pk,
  event_id uuid fk -> events,
  full_name text not null,
  email text,                         -- lowercased, trimmed
  phone text,
  class_year text,
  team_name text,
  source text check (source in ('form','walk_in')) not null,
  added_by_staff_id uuid fk -> staff null,   -- set for walk-ins
  form_response_id text null,         -- Google Form response id (idempotency)
  qr_token text unique not null,      -- 32 random bytes, base64url
  short_code text not null,           -- 6 chars, e.g. "K7Q9XM", for manual lookup
  email_status text check (email_status in ('none','pending','sent','failed')) default 'pending',
  email_error text,
  email_sent_at timestamptz,
  created_at timestamptz default now(),
  unique (event_id, form_response_id),
  unique (event_id, short_code)
)
-- one attendee per email per event:
create unique index on attendees (event_id, email) where email is not null;

checkins (
  id uuid pk,
  attendee_id uuid fk -> attendees,
  event_day_id uuid fk -> event_days,
  staff_id uuid fk -> staff not null,
  method text check (method in ('qr','manual','walk_in')) not null,
  checked_at timestamptz default now(),
  undone_at timestamptz,
  undone_by_staff_id uuid fk -> staff
)
-- THE key rule: one active check-in per person per day.
create unique index one_checkin_per_day
  on checkins (attendee_id, event_day_id) where undone_at is null;

audit_log (
  id bigserial pk,
  staff_id uuid null,
  action text not null,               -- 'login','login_failed','checkin','checkin_rejected',
                                      -- 'manual_checkin','walk_in','undo','resend','edit_email',
                                      -- 'export','create_event','create_staff', ...
  event_id uuid null,
  attendee_id uuid null,
  details jsonb,
  at timestamptz default now()
)
```

**Check-in must be atomic.** Insert into `checkins` and rely on the partial unique index. On a unique-violation error, fetch the existing check-in and return `ALREADY_CHECKED_IN`. Never do "select, then insert" without the constraint. A Postgres function (`rpc`) that does it in one transaction is fine too.

## 5. Rules

- **Multi-day:** a QR code works **once per day**. The scanner uses the event day matching today's date (Africa/Tunis timezone). If today is not an event day, show "No event day today" and let an admin pick a day manually.
- **Duplicates:** if the same email submits the form twice for the same event, do **not** create a second attendee. Update the details and resend the **same** QR.
- **Walk-ins:** **any** HR member can add one. Required: full name. Optional: phone, email, class/year, team. The walk-in is created and checked in for today in one step. If an email is given, also send them their QR (useful for day 2).
- **Traceability:** every write action records `staff_id` and goes into `audit_log`.

## 6. Auth (per-person PINs)

- Login screen: pick your name from a list (active staff only), then type a 6-digit PIN.
- Verify with bcrypt. On success, set an httpOnly, Secure, SameSite=Lax signed session cookie (JWT or iron-session), valid for **12 hours**.
- After 5 wrong PINs: lock that staff account for 10 minutes (`locked_until`). Log `login_failed`.
- Roles:
  - `hr`: scan, search, manual check-in, walk-in, undo **their own** check-ins within 10 minutes, resend QR, fix email, view stats, export CSV.
  - `admin`: everything above, plus create/edit events and days, manage staff (create, reset PIN, deactivate), undo any check-in, view the audit log, see `form_secret`.
- Seed script: `npm run seed:admin -- --name "Amyyn" --pin 123456` creates the first admin.

## 7. API routes

| Method | Route | Who | Purpose |
|---|---|---|---|
| POST | `/api/form-submit` | Apps Script | New Google Form response (see section 8) |
| POST | `/api/auth/login` | public | `{staff_id, pin}` |
| POST | `/api/auth/logout` | staff | |
| GET | `/api/staff/list` | public | names + ids only, for the login screen |
| GET | `/api/events` | staff | active events + their days |
| POST | `/api/checkin` | staff | `{event_id, token}` → scan result |
| GET | `/api/attendees/search?event_id&q` | staff | by name, email, phone or short code |
| POST | `/api/checkin/manual` | staff | `{attendee_id, event_id}` |
| POST | `/api/walkin` | staff | `{event_id, full_name, phone?, email?, class_year?, team_name?}` |
| POST | `/api/checkin/undo` | staff | `{checkin_id}` |
| POST | `/api/attendees/:id/resend` | staff | optional `{email}` to correct a typo first |
| GET | `/api/events/:id/stats` | staff | registered, checked in today, walk-ins, per-day counts |
| GET | `/api/events/:id/export.csv` | staff | logs `export` |
| GET | `/api/events/:id/backup.pdf` | staff | printable list (see section 9) |
| POST | `/api/admin/emails/retry-failed` | admin | resend all `failed` emails |
| CRUD | `/api/admin/events`, `/api/admin/staff` | admin | |
| GET | `/api/admin/audit?event_id` | admin | |

**`/api/checkin` responses** (always HTTP 200 with a `status` field, so the UI is simple):

```
OK                  { name, team_name, class_year, day_label }
ALREADY_CHECKED_IN  { name, checked_at, by_staff_name }
WRONG_EVENT         { name, other_event_name }
INVALID             {}                       -- token not found
NO_EVENT_DAY        {}
```

The QR content is: `CT1:<qr_token>`. The scanner rejects anything without the `CT1:` prefix as `INVALID` without calling the server.

## 8. Google Form + Apps Script

**Form questions (exact titles):** `Full name`, `Email`, `Phone`, `Class / Year`, `Team name` (optional). Turn on "Collect email addresses" if wanted; the script prefers the `Email` question and falls back to `getRespondentEmail()`.

**Apps Script (bound to each event's form), deliver as `apps-script/Code.gs` plus setup steps:**
- Script Properties: `API_URL`, `EVENT_SLUG`, `FORM_SECRET`.
- An installable `onFormSubmit` trigger reads the answers and POSTs JSON to `/api/form-submit` with header `X-Form-Secret`:
  ```json
  { "event_slug": "...", "response_id": "...", "full_name": "...", "email": "...",
    "phone": "...", "class_year": "...", "team_name": "..." }
  ```
- **Reliability:** if the POST fails (network error or non-2xx), record the response id in a "pending" list (Script Properties or a sheet). A **time-driven trigger every 5 minutes** retries pending items. This way no registration is lost even if the API is down.
- Include a `syncAll()` function that re-sends every existing response (safe, because the API is idempotent on `response_id`).

**`/api/form-submit` behavior:**
1. Check `X-Form-Secret` against `events.form_secret` for `event_slug` (constant-time compare). Wrong → 401.
2. Upsert the attendee (idempotent on `response_id`, deduplicated on email).
3. Respond **200 quickly**, then send the email. If Vercel can't send after responding, send before responding, but keep it under 10 seconds. On email failure, set `email_status='failed'` and store the error. Admins retry from the dashboard.

## 9. Email

- From: `Cybertrace Club <cybertrace.issatso@gmail.com>`
- Subject: `Your check-in QR code — <event name>`
- HTML body: greeting with their name, event name, dates, location, the **QR image**, the **short code** in large text ("If the QR doesn't work, give this code at the desk: K7Q9XM"), and "Don't share this code. It works once per day."
- **Embed the QR as a CID inline attachment** (`cid:qr`). Gmail blocks `data:` image URLs. Also attach it as `qr.png`.
- Plain-text alternative included.
- Send one at a time (no bulk burst). Gmail limit is about 500 per day.

**Backup PDF** (generate the night before the event): a table sorted by name with name, class, team, short code, and an empty tick box per day. Use `pdfkit` or `@react-pdf/renderer`.

## 10. Pages (mobile-first, PWA)

- `/login` — name list + PIN pad.
- `/` — pick an active event (auto-selects if only one).
- `/scan` — full-screen camera. After each scan, show a **full-screen color result** for 1.5 s, then resume automatically:
  - green = OK (name, team), short vibration
  - orange = already checked in (by whom, at what time)
  - red = invalid / wrong event
  - Debounce: ignore the same token for 3 s.
  - A live counter at the top: "Checked in today: 57 / 112".
  - A visible red banner when the connection is lost.
- `/search` — search box → results → "Check in" button. Also "Resend QR" and "Fix email".
- `/walkin` — quick form, big submit button.
- `/recent` — the last 20 check-ins by me, each with "Undo".
- `/admin` — events, days, staff, failed emails, audit log, CSV, backup PDF, and the event's `form_secret` + Apps Script setup instructions.
- PWA: `manifest.json`, icons, `display: standalone`, so staff can "Add to Home Screen" on iPhone and Android. The camera needs HTTPS (Vercel provides it).

## 11. Build phases

1. **Database:** SQL migrations + seed admin script.
2. **Auth:** login, sessions, roles, lockout.
3. **Form ingestion:** `/api/form-submit` + email sending + Apps Script with retry.
4. **Scanner:** `/scan` + `/api/checkin` (atomic).
5. **Flexible cases:** search, manual check-in, walk-in, undo, resend/fix email.
6. **Admin + exports:** dashboard, stats, CSV, backup PDF, audit log.
7. **PWA polish** and a README with full setup steps.

## 12. Tests (required)

- **Double-scan race:** fire 20 parallel `/api/checkin` calls with the same token → exactly 1 `OK`, 19 `ALREADY_CHECKED_IN`.
- **Idempotent form:** post the same `response_id` 3 times → 1 attendee, no duplicate emails.
- **Same email twice** (different response ids) → 1 attendee, the same QR resent.
- **Multi-day:** check in on day 1 → OK; same token on day 2 → OK; again on day 2 → ALREADY.
- **Wrong event token** → WRONG_EVENT.
- **Load:** seed 150 attendees and simulate 4 scanners checking everyone in within 5 minutes; no errors.
- **PIN lockout** after 5 wrong attempts.
- **CSV** contains: name, email, phone, class, team, source, added_by, and per day: checked_at + checked_by.

## 13. Out of scope for v1

Offline scanning (planned for v2: cache the attendee list on the phone, queue scans, sync later), payments, sending email from a custom domain.
