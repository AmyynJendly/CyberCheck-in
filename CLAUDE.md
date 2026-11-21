# Cybertrace Check-in — notes for Claude Code

QR check-in web app (mobile PWA) for the Cybertrace club (ISSAT Sousse). Read `README.md` (features, setup) and `HOSTING.md` (deployment, stability, event-day checklist, stress test) before larger changes. `SPEC.md` is the original spec; deviations are listed at the end of the README.

## Stack
Next.js 15 (App Router) + TypeScript + Tailwind v4 · Postgres via `pg` (Supabase in production, `DATABASE_URL`) · Nodemailer → Gmail SMTP · `qrcode` / `zxing-wasm` (scanner; its .wasm is copied to `public/zxing/` before dev/build) · `exceljs` (final report) · Google Apps Script (`apps-script/Code.gs`) · Vitest.

## Layout
- `src/lib/checkin.ts` — ALL check-in logic (scan, manual, pay-then-check-in, claim, undo). One lookup query + one atomic write per scan.
- `src/lib/attendees.ts` — form ingestion (idempotent on response id, dedup on email), walk-ins ("Add Person"), search.
- `src/lib/email.ts` — QR email building + single-sender queue (DB lease) over one Gmail connection. `email-designs.ts` (Borderland default, Classic), `email-defaults.ts` (default texts), `email-logo.ts` (base64 logo).
- `src/lib/members.ts`, `payments.ts`, `stand.ts` — membership list, cash, registration-stand sheet import.
- `src/lib/report.ts` — final Excel report (sheet per day + Statistics), admin-only; `src/lib/ticks.ts` — form ticks vs days.
- `src/app/{login,scan,search,walkin,recent}` — HR app. `src/app/admin/**` — admin dashboard. `src/app/api/**` — routes.
- `migrations/*.sql` — schema, applied in order by `npm run migrate`. Never edit an applied migration; add a new numbered file.
- `data/` — git-ignored: registration exports, `import-registrations.ts` + `import-report.md`, `demo-setup.ts` / `demo-rollback.ts`, backups. Personal data: never commit.

## Rules that must not break
- One active check-in per person per day: partial unique index `one_checkin_per_day`. Never "select then insert".
- Seat limits: trigger on `checkins` keeps `event_days.seats_taken`; raises `DAY_FULL`. Exception (migration 009): people who paid at the registration stand get in on a full day (`checkins.over_limit`).
- Payment + check-in happen in one transaction, check-in row first. Undo reverses the whole door action: cancels the payment, removes a membership created with that check-in, puts back an expired membership it renewed (migration 012: `members.prev_valid_until/prev_needs_review/extended_at`), and removes a person added with Add Person when that was their only check-in and no QR email went out.
- Every write goes to `audit_log` with the staff id.
- HR vs admin: CSV, final report, backup list, payments list, members, staff, events, imports are admin-only (`requireStaff(req, "admin")`).
- Login is PIN-only: `staff.pin_lookup` = HMAC(`PIN_PEPPER`, pin), unique. Limits per IP and app-wide (`login_throttle`).
- QR emails are never sent automatically: they wait until an admin presses Admin → Emails → Send Waiting Now. Exceptions, both off: the per-event **Auto-send** switch (Admin → Emails; sends door walk-ins every N minutes, driven by the stats polling, `maybeAutoSend`) and the `EMAIL_AUTO_SEND=on` env var. Resend in Search sends one person's email. The secret QR token never appears in an email. Keep Auto-send OFF unless the user turns it on.
- No secrets in code or git. `.env.local` (git-ignored) holds them; Vercel holds production values.

## Current event: TracersCamp (slug `bootcamp`), 23–27 Nov 2026, ISSAT Sousse
| Date | Day | Rule | Seats |
|---|---|---|---|
| Mon 23 | Linux fundamentals | free | 80 |
| Tue 24 | Networks under attack | members only, join 15 DT | 70 |
| Wed 25 | Offensive Web 101 | members only | 70 |
| Thu 26 | Cybersecurity and CTF fundamentals | members only | 70 |
| Fri 27 | CyberDay CTF | members free, others 5 DT | 120 |

- 88 registered (imported from `data/`; forms are closed: new people only via Add Person at the door). 32 members, all paid 15 DT at the stand (`members.source = 'stand'`); the 4 who only said "I have a membership" are NOT members. Membership lasts until 31 August.
- HR can admit "already a member, not on the list" (no money; Youssef reviews in Members → To check).
- Staff: Youssef Hamouda is the only admin; the user is HR "Mohamed Amine Jendli".
- Email: Borderland design, tagline "♠ Alice in Borderland Edition ♦", text ends with a "Don't forget to bring" list. Two people have a second address (`attendees.alt_email`).

## Commands
- `npm run dev` — local app on http://localhost:3000 (uses `.env.local`, which points at the PRODUCTION database).
- `npm run typecheck`, `npm run build` — must pass with zero errors before pushing.
- `npm test` — 99 tests (the latency benchmark only runs with PERF=1). They DROP and recreate their database, so they only run against a LOCAL Postgres; a guard refuses remote hosts. This machine has no Docker: the user approved an `embedded-postgres` server in the session scratchpad (port 5432) for tests; ask before starting one.
- `npm run migrate`, `npm run seed:admin -- --name "X" --pin 123456`.
- `npm run loadtest -- --url … --slug load-test --pin …` and `npm run stresstest -- --url … [--bursts-only]` — against the deployed app (see HOSTING.md); the stress test creates and deletes its own TEST data.

## Environment
- Live at https://cybertrace-checkin.vercel.app (Vercel project `cybertrace-checkin`; pushes to `claude/magical-darwin-jfstg9` deploy to production).
- Database: Supabase in eu-west-1 (Ireland); Vercel functions pinned to `dub1`. Local dev and production share the same database: name test data "TEST…", and run migrations before pushing code that needs them.
- Vercel env: `DATABASE_URL`, `SESSION_SECRET`, `PIN_PEPPER` (same value as `.env.local`), `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `APP_BASE_URL`, `PG_POOL_MAX=2`. Not set: `DEV_EMAIL_MODE`, `EMAIL_AUTO_SEND`.
- `DEV_EMAIL_MODE=log` locally: emails are written to `dev-emails/` instead of sent.

## Still to do (as of 21 Nov 2026)
- Admin → Emails → Send Waiting Now (88 QR emails; Gmail works).
- HR: hand out PINs privately; everyone logs in once on their phone (home screen, camera). New PINs for Zayneb / Mohamed Amine if forgotten.
- Sunday night: print the backup list. Each day: test scan before doors, download the day's CSV after.
- After 27 Nov: Final Report; revoke the Gmail app password (it was shared in a chat).
- Offline scanning: deliberately not built (online-only).

## Style
UI follows Apple's dark-mode design (system font, iOS grouped lists, sheets); tokens and the brand accent are at the top of `src/app/globals.css`. Copy is short and plain. Keep the HR screens minimal: Scan, Search, Add Person (name, email, phone).
