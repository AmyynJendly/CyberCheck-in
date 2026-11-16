# Hosting: fast, stable, free

The short version: **Vercel (Hobby, free) in Dublin + Supabase (Free) in Ireland (eu-west-1) + the club Gmail.** Both servers sit in the same region. Every piece scales on its own, and the rules that must never break (one check-in per person per day, seat limits, no double payments) are enforced by the database itself, so they hold however many phones scan at once.

## Why this setup holds up

| Risk | What the app does about it |
|---|---|
| Many phones scanning at once | Each scan is **3 database round trips** (sign-in check, one lookup, one atomic write). Measured on one machine: 1000 people checked in by 20 phones in 2.9 s, p95 64 ms, zero errors. Your busiest day is 120 people. |
| Two phones scan the same ticket | A unique index in Postgres allows only one check-in per person per day. The second phone gets "Already checked in" (tested with 20 phones at once). |
| Overselling seats | A database trigger takes a seat with each check-in and refuses when the session is full (tested: 20 people at once for 5 seats → exactly 5 in). Full is reported **before** anyone pays. |
| Double charging | Payment + check-in are one transaction; a second phone confirming the same payment gets "Already checked in" and nothing is charged (tested with 10 phones). |
| Registration rush (everyone fills the form at once) | Google Forms takes the load (Google's servers). The Apps Script forwards each response and retries every 5 minutes if the app is unreachable, so no registration is lost. |
| Gmail blocking a burst of emails | Emails go through a **queue with a single sender** over one reused Gmail connection. Gmail errors leave emails waiting and they're retried automatically; nothing is sent twice (tested with 40 simultaneous registrations). |
| Bad mobile network at the door | The scanner shows a red "No connection" bar and a "Not saved, scan again" screen. Re-scanning is always safe (it can't double check-in or double charge). |
| Server far from the database | `vercel.json` pins the functions to **Dublin (`dub1`)**, the same region as the Supabase project (eu-west-1, Ireland). If Supabase is ever moved, change `regions` in `vercel.json` to match (Frankfurt = `fra1`). Every round trip is then ~1–2 ms instead of ~90 ms (US default). |
| Database asleep (Supabase free pauses after ~7 idle days) | A daily Vercel cron calls `/api/health`, which reads the database. Still, check the project is running before registration opens. |

Things that typically make event sites crash, and that this setup avoids: free hosts that go to sleep (the first visitor waits 30–60 s), one small server handling everything, Google Sheets as a database, and no rule in the database against double check-ins.

## Setting it up

### 1. Supabase (database)
1. <https://supabase.com> → New project. **Region: West EU (Ireland), `eu-west-1`**. Plan: Free. Choose a strong database password and keep it.
2. Project → **Connect** → **Transaction pooler** → copy the URI (port **6543**). Replace `[YOUR-PASSWORD]`. This is `DATABASE_URL`.
3. From your computer, create the tables and the first admin (use the **Session pooler** URI, port 5432, for these two commands):
   ```bash
   DATABASE_URL="postgresql://postgres.<ref>:<password>@aws-0-eu-west-1.pooler.supabase.com:5432/postgres" npm run migrate
   DATABASE_URL="…same…" npm run seed:admin -- --name "Amyyn" --pin <your PIN>
   ```

### 2. Vercel (app)
1. <https://vercel.com/new> → import the GitHub repo. Plan: **Hobby** (free; fine for a student club, not for commercial use).
2. Environment variables (Settings → Environment Variables): `DATABASE_URL` (transaction pooler, port 6543), `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `SESSION_SECRET`, `PIN_PEPPER` (the same value as in your `.env.local`), `APP_BASE_URL` (your `https://…vercel.app`), `PG_POOL_MAX=5`. Do **not** set `DEV_EMAIL_MODE`.
3. Deploy. Then check:
   - Settings → Functions → **Region shows Dublin (dub1)** (set by `vercel.json`, matching Supabase eu-west-1).
   - Settings → Cron Jobs shows `/api/health` daily.
   - `https://<your-app>.vercel.app/api/health` → `{"ok":true,"db":"up"}`.

### 3. Gmail (emails)
The club Gmail with an **app password** (Google Account → Security → 2-Step Verification on → <https://myaccount.google.com/apppasswords>). It's free and the emails come from the club address people know. Regular Gmail allows about **500 emails a day**: plenty for 120–200 registrations plus resends, but don't use the same account for a mass mailing on registration day.

Other email services exist (Brevo, Resend, Mailgun) but they need your own domain to land reliably in inboxes; sending "from" a @gmail.com address through them often ends in spam. Gmail SMTP is the right free choice until the club has a domain.

## Free-tier limits that matter

| Service | Limit | Effect for you |
|---|---|---|
| Vercel Hobby | Functions run up to 60 s; 1 cron job per day | The app keeps every request well under that (email sending works in 40 s slices). |
| Supabase Free | 500 MB database; ~200 pooled connections; pauses after ~7 idle days; no downloadable backups | One event uses well under 5 MB. Connections: 5 per server instance. Download the CSVs after each session (Admin → Overview), and optionally a full dump: `pg_dump "<session pooler URI>" > backup.sql`. |
| Gmail | ~500 recipients per day | See above. The Emails page shows anything waiting or failed. |

If one day you outgrow the free tiers, the same code runs unchanged on Supabase Pro / Vercel Pro.

## Before each event

**The week before**
- [ ] `https://<app>/api/health` returns `{"ok":true,"db":"up"}` and the Supabase project is running (not paused).
- [ ] Create a separate **Load test** event (slug `load-test`, one day = today, no seat limit) and run against the live site:
      ```bash
      npm run loadtest -- --url https://<app>.vercel.app --slug load-test --secret <its FORM_SECRET> --pin <a staff PIN> --people 150 --scanners 8
      ```
      It should end with "✓ No errors". Then deactivate the Load test event.
- [ ] Admin → Emails: send yourself a test email; check it arrives in the inbox (not spam) on Gmail and on a phone.
- [ ] Every HR member has an account and has signed in once on their own phone (Add to Home Screen).

**The day before**
- [ ] Admin → Emails: nothing failed or waiting.
- [ ] Admin → Events: today's day exists, the entry rule and seats are right.
- [ ] Print the backup list (Admin → Overview → Backup list).

**On the day**
- [ ] Scanner phones on **mobile data (4G)** rather than the venue Wi-Fi, which is often the first thing to fail when a room fills up.
- [ ] Phones charged, screen brightness up.
- [ ] Each HR member scans one test ticket before doors open.
- [ ] If the network drops: tick people on the printed list with their code, and check them in with Search once you're back online (same day).
- [ ] After the session: Admin → Overview → download that day's CSV.

## If something goes wrong
- **Everything shows "No connection"**: it's the phone's network. Switch Wi-Fi ↔ mobile data.
- **The app doesn't load at all**: open `/api/health`. If it says `"db":"down"`, check Supabase (paused? → Restore). Vercel's dashboard → Logs shows server errors.
- **Emails not arriving**: Admin → Emails shows each one's status and the Gmail error. "Waiting" ones retry automatically; fix the address with Search → Fix Email.
