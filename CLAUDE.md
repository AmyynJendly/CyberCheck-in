# Cybertrace Check-in — notes for Claude Code

QR check-in web app (mobile PWA) for the Cybertrace club (ISSAT Sousse). Read `README.md` (features, setup) and `HOSTING.md` (deployment, stability, event-day checklist) before larger changes. `SPEC.md` is the original spec; deviations are listed at the end of the README.

## Stack
Next.js 15 (App Router) + TypeScript + Tailwind v4 · Postgres via `pg` (Supabase in production, `DATABASE_URL`) · Nodemailer → Gmail SMTP · `qrcode` / `zxing-wasm` (scanner; its .wasm is copied to `public/zxing/` before dev/build) · Google Apps Script (`apps-script/Code.gs`) · Vitest.

## Layout
- `src/lib/checkin.ts` — ALL check-in logic (scan, manual, pay-then-check-in, claim, undo). One lookup query + one atomic write per scan.
- `src/lib/attendees.ts` — form ingestion (idempotent on response id, dedup on email), walk-ins ("Add Person"), search.
- `src/lib/email.ts` — QR email template rendering + single-sender queue (DB lease) over one Gmail connection.
- `src/lib/members.ts`, `payments.ts`, `stand.ts` — membership list, cash, registration-stand sheet import.
- `src/app/{login,scan,search,walkin,recent}` — HR app. `src/app/admin/**` — admin dashboard. `src/app/api/**` — routes.
- `migrations/*.sql` — schema, applied in order by `npm run migrate`. Never edit an applied migration; add a new numbered file.

## Rules that must not break
- One active check-in per person per day: partial unique index `one_checkin_per_day`. Never "select then insert".
- Seat limits: trigger on `checkins` (migration 004) keeps `event_days.seats_taken`; raises `DAY_FULL`.
- Payment + check-in happen in one transaction, check-in row first.
- Every write goes to `audit_log` with the staff id.
- HR vs admin: CSV, backup list, payments list, members, staff, events, imports are admin-only (`requireStaff(req, "admin")`).
- No secrets in code or git. `.env.local` (git-ignored) holds them; Vercel holds production values.

## Bootcamp rules (current event)
Session 1 free (80 seats) · Sessions 2–4 members only, join for 15 DT (60 seats) · Main event: members free, others 5 DT (120 seats). Membership lasts until 31 August (academic year). HR can admit "already a member, not on the list" (no money, admin reviews in Members → To check). Stand sheet import: paid + sessions = membership, paid + main event only = entry fee; stand money is `payments.channel = 'stand'`, separate from door cash.

## Commands
- `npm run dev` — local app on http://localhost:3000 (uses `.env.local`).
- `npm run typecheck`, `npm run build` — must pass with zero errors before pushing.
- `npm test` — 83 tests. They DROP and recreate their database, so they only run against a LOCAL Postgres (`docker compose up -d db`); a guard refuses remote hosts.
- `npm run migrate`, `npm run seed:admin -- --name "X" --pin 123456`.
- `npm run loadtest -- --url … --slug load-test …` — load test against the deployed app (see HOSTING.md).

## Environment
- Database: Supabase project in eu-west-1 (Ireland); Vercel functions pinned to `dub1` in `vercel.json` to match. Local dev and production share the same Supabase database: name test data "TEST…".
- `DEV_EMAIL_MODE=log` locally: emails are written to `dev-emails/` instead of sent.

## Still to do (as of the move to local)
- Gmail app password for cybertrace.issatso@gmail.com (emails wait in the queue until it's set; then Admin → Emails → Retry Failed / Send Waiting Now).
- Deploy to Vercel (HOSTING.md), create the bootcamp event, connect the Google Form + Apps Script, paste the email template, import the member list, create HR accounts, import the stand sheet before Session 1, load test, test on real phones.
- Offline scanning: deliberately not built (online-only for now).

## Style
UI follows Apple's dark-mode design (system font, iOS grouped lists, sheets); tokens and the brand accent are at the top of `src/app/globals.css`. Copy is short and plain. Keep the HR screens minimal: Scan, Search, Add Person (name, email, phone).
