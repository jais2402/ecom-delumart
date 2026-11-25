# Deploying DeluluMart: Vercel (Hobby) + Supabase (Free, Mumbai)

A checklist for the owner. Follow it in order and tick each step. You never paste a secret into a
chat, an issue or an email: when something fails, send only the outputs this runbook marks as
**safe to share**.

Dashboards change their labels from time to time. Where this runbook names a screen, the exact
wording may differ slightly; look for the closest match. Every point we could not test against the
real services is collected in [Verify on first deploy](#9-verify-on-first-deploy).

---

## 0. What you need

- The Supabase project (region Mumbai, `ap-south-1`) with JWT signing keys set to ECC (P-256).
  Write down its **project ref**: the 20 letters in `https://<project-ref>.supabase.co`.
- The Vercel project connected to the GitHub repository.
- On your own computer: this repository checked out, Node.js 22, pnpm (`corepack enable`), and
  `pnpm install` run once. `openssl` (macOS and Linux have it).
- A password manager. Every secret you generate goes there first, then into Vercel.

## 1. Generate the secrets (on your own computer)

Run each command on your own computer and store each result in your password manager under the
name shown. Never reuse a value for two names.

```bash
openssl rand -hex 32   # IDENTITY_KEY
openssl rand -hex 32   # CARD_KEY
openssl rand -hex 32   # PIN_PEPPER
openssl rand -hex 32   # FIELD_KEY
openssl rand -hex 32   # JOBS_SIGNING_KEY
openssl rand -hex 32   # ANALYTICS_KEY
openssl rand -hex 32   # CRON_SECRET
openssl rand -hex 24   # APP_WEB_PASSWORD   (database login of the web app)
openssl rand -hex 24   # APP_PAY_PASSWORD   (database login for money commands)
openssl rand -hex 24   # APP_JOBS_PASSWORD  (database login of the job runner)
```

**Never change after launch** (back them up now, in two places):

| Key | Why it can never change |
|---|---|
| `IDENTITY_KEY` | Email and phone fingerprints are HMACs with it. A new key makes every existing account unfindable by email and lets the same phone register twice; `admin:grant` also stops finding accounts. |
| `CARD_KEY` | Card numbers are derived from it. A new key changes the numbers a player would be shown for new cards and breaks uniqueness guarantees. |
| `PIN_PEPPER` | Stored PIN hashes include it. A new pepper makes every PIN wrong. |
| `FIELD_KEY` | Birthdates and addresses are encrypted with it. A new key makes them unreadable. |

`JOBS_SIGNING_KEY`, `ANALYTICS_KEY`, `CRON_SECRET`, the three database passwords, the Supabase
secret key and the Turnstile secret key **can** be rotated (see [section 11](#11-backup-and-rotation-of-keys)).

**Typing a secret into a terminal.** Never write a password into a command line (`export X='...'`
ends up in your shell history). The owner scripts ask for what they need at prompts that do not
echo (the owner connection string and its password, the three login passwords, `IDENTITY_KEY`, the
admin email). If you prefer to put a value into the terminal's environment, read it without echo:

```bash
# bash
read -rsp 'DATABASE_URL_OWNER: ' DATABASE_URL_OWNER; echo; export DATABASE_URL_OWNER
# zsh
read -rs 'DATABASE_URL_OWNER?DATABASE_URL_OWNER: '; echo; export DATABASE_URL_OWNER
```

(the same for `APP_WEB_PASSWORD`, `APP_PAY_PASSWORD`, `APP_JOBS_PASSWORD` and `ADMIN_EMAIL`). The
owner connection string may also be given WITHOUT its password, e.g.
`postgresql://postgres.<project-ref>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres` (not secret):
the scripts then ask for the password alone.

## 2. Supabase settings (dashboard)

### 2.1 Database: TLS certificate

1. Project Settings → Database → **SSL Configuration**: turn on *Enforce SSL on incoming
   connections*.
2. Same section: **Download certificate**. You get a file such as `prod-ca-2021.crt`. Keep it; it
   is not secret.

### 2.2 Connection strings (Project → **Connect** button at the top)

You need two kinds, both from the *Connect* dialog:

- **Session pooler** (host `aws-0-ap-south-1.pooler.supabase.com` or similar, **port 5432**, user
  `postgres.<project-ref>`): for the owner scripts on your computer. (The *Direct connection*
  `db.<project-ref>.supabase.co` also works but is IPv6-only on the free plan.)
- **Transaction pooler** (same host, **port 6543**): for Vercel. You will replace the user
  `postgres.<project-ref>` with `app_web.<project-ref>`, `app_pay.<project-ref>` and
  `app_jobs.<project-ref>`, and the password with the matching generated one.

Do not add `?sslmode=...` to any of them: the app removes it and verifies TLS itself.

### 2.3 Data API: switch it off

This app never uses Supabase's auto-generated REST/GraphQL API. Project Settings → **Data API**:
turn the Data API off. If you cannot, set **Exposed schemas** to nothing (remove `public` and
`graphql_public`). The migrations also revoke every privilege the API roles (`anon`,
`authenticated`, `service_role`) could have on the app's tables, and `pnpm db:doctor` checks both.

### 2.4 Authentication

Authentication → **URL Configuration**:

- *Site URL*: your app origin, e.g. `https://delulumart.example` (or `https://<project>.vercel.app`).
- *Redirect URLs*: add exactly `https://<your-origin>/api/v1/auth/callback/**` (Google) and
  `https://<your-origin>/sign-in/confirm` (the emailed link's page).

Authentication → **Sign In / Providers**:

- *Allow new users to sign up*: on. *Anonymous sign-ins*: **off**. *Manual linking*: off.
- **Email**: enabled; *Confirm email* **on** (an address must be proven before an account can sign
  in with it, and Supabase links a Google identity automatically only to an account whose email is
  confirmed: with *Confirm email* off, someone could create an unconfirmed account for your address
  first and later share it). *Secure email change* on. *Email OTP expiration*: 900 seconds (15
  minutes). *Email OTP length*: 6. The app itself never accepts a session it did not create through
  its own sign-in (password, phone-OTP or implicit-flow sessions minted directly at Supabase are
  refused by the database, migration 0074).
- **Google**: in Google Cloud Console create an OAuth client ("Web application") whose
  *Authorized redirect URI* is `https://<project-ref>.supabase.co/auth/v1/callback`; paste its client
  id and secret here and enable Google.
- **Phone**: only if you choose SMS verification (section 2.6). Otherwise leave it off.

**Custom SMTP comes first.** The dashboard does not let you edit email templates until custom SMTP
is set up (Authentication → Emails → *Set up SMTP*), and the default templates do not work with this
app: their link goes to Supabase's own verify endpoint, which the app no longer accepts for email
sign-in, and they carry no typed code. Without a domain, a dedicated Gmail account works for testing
(host `smtp.gmail.com`, port `465`, username the Gmail address, password a Google *app password*,
which needs 2-Step Verification; about 500 emails a day). With a domain, use Resend or Brevo.

Authentication → **Emails**: edit **both** templates, *Magic Link* (existing users) and *Confirm
signup* (a first sign-in creates the user and Supabase sends this one instead). Each must contain the
app's link (NOT `{{ .ConfirmationURL }}`) and the code:

```html
<p><a href="{{ .SiteURL }}/sign-in/confirm?token_hash={{ .TokenHash }}&type=email">Sign in to DeluluMart</a></p>
<p>Or type this code: {{ .Token }}</p>
```

Why: mail scanners open links in emails before people do. `{{ .ConfirmationURL }}` points at
Supabase's own verify endpoint, which spends the one-time token on that first GET. The app's link
only opens a page with a **Sign in** button; the token is redeemed when the person presses it (a
POST from the browser that asked for the email), never on a GET. The page checks `type` and the
token's format on the server. *Site URL* must be your app origin for `{{ .SiteURL }}` to be right.

Authentication → **Rate Limits**: Supabase's limits are shared by EVERY user of the app. All of the
app's calls to Supabase come from Vercel's servers, so Supabase sees a handful of Vercel addresses,
not your players: its per-IP limits (*Sign-ups and sign-ins*, *Token verifications*, *OTP*) and the
project's **email quota** are one pool for everybody, and one abuser can use them up for all. The app
keeps its own per-person, per-network and per-address limits and a Turnstile check in front of every
email and text message (section 2.7). Before real traffic:

- set up **custom SMTP** (Authentication → Emails → SMTP settings; e.g. Resend or Brevo free tier,
  needs a domain): the built-in sender sends only a few emails per hour for the whole project;
- raise *Sign-ups and sign-ins*, *Token verifications* and *Email/SMS OTP* limits from their defaults
  (the app's own limits are the ones that separate people);
- **Attack Protection → Captcha protection: leave it OFF.** The app verifies Cloudflare Turnstile
  itself; Supabase's captcha would need the same single-use token a second time and refuse sign-ins.

Authentication → **Sessions**: nothing to set on the free plan. The app ends every session 7 days
after sign-in itself (owner setting `auth.session_max_age_seconds`, section 6).

JWT Keys: keep the **ECC (P-256)** key as the current signing key. The app accepts only ES256
tokens and reads the public keys from `https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json`.

### 2.5 API keys

Project Settings → **API Keys**: copy the **publishable** key (`sb_publishable_...`) and create or
copy a **secret** key (`sb_secret_...`). The app uses only these new-style keys, never the legacy
`anon` / `service_role` JWT keys.

### 2.6 Phone verification: decide

- **`sms`** (default, costs money per message): Authentication → Providers → Phone: enable it and
  connect an SMS provider (Twilio, MessageBird, Vonage or Textlocal; Indian numbers usually need
  sender registration). Keep its spend limit low. Set *SMS OTP Expiry* to **600** seconds: the app
  releases a number someone asked a code for but never confirmed after the same 10 minutes
  (`phone_code_lifetime_seconds`), so a squatted number is freed for its owner. The app also sends at
  most 3 texts an hour and 5 a day to one number, whoever asks, and lets one account try at most 3
  different numbers a day (5 in all before onboarding completes).
- **`unverified`** (free at launch): no SMS. The app still allows only one account per phone number,
  but cannot tell whether the number is really the person's. After the migrations (section 4), run in
  Supabase's SQL editor:
  ```sql
  UPDATE core.deployment_setting SET value = 'unverified', updated_at = now()
   WHERE key = 'identity.phone_verification';
  ```
  To go back: the same with `'sms'`. Only the owner can change this (no app login can). A number
  recorded this way is shown as **not verified**; if its real owner later confirms it by text message
  (in `sms` mode) the number moves to them and the other account is asked for a number again (nothing
  else about that account changes). Two unverified claims of one number: the first wins, but lapses
  after 24 hours if that account has not finished onboarding.

### 2.7 Bot protection: Cloudflare Turnstile

The app asks for a Turnstile check before it sends a sign-in email, checks a typed email code, or
sends a phone code. Production with `AUTH_PROVIDER=supabase` refuses to start without the two keys
(unless `CAPTCHA=off` is set explicitly, which `/api/v1/admin/health` then reports as a warning).

1. Cloudflare dashboard (a free account is enough) → **Turnstile** → **Add site** (or *Add widget*).
2. *Site name*: DeluluMart. *Hostname*: your app's host name only, e.g. `delulumart.example` (no
   `https://`, no path; add the `*.vercel.app` name too only if people use it). *Widget mode*:
   **Managed**. Pre-clearance: no.
3. Copy the **Site key** into Vercel as `TURNSTILE_SITE_KEY` (public: it is sent to browsers) and the
   **Secret key** as `TURNSTILE_SECRET_KEY` (server-only; the build fails if it reaches browser code).
   Store the secret in your password manager.
4. After deploying: the sign-in page shows the check under the form, and `/api/v1/admin/health`
   reports `captcha: "on"`.

The server checks every token with Cloudflare (`https://challenges.cloudflare.com/turnstile/v0/siteverify`)
with a 5-second timeout and refuses the request if Cloudflare cannot be reached (fail closed). A token
works once, only for the action and the host name it was issued for.

## 3. Pre-flight check (your computer)

```bash
export DATABASE_CA_CERT_FILE=~/Downloads/prod-ca-2021.crt
pnpm db:doctor
```

It asks for the owner connection string (Supabase → Connect → Session pooler, port 5432; the
password may be left out) and then for the database password, at prompts that do not echo. (Or read
`DATABASE_URL_OWNER` into the terminal first with the hidden `read` of section 1.)

Before migrating, expect `INFO` for pending migrations and roles not created yet. Any **FAIL** must be
fixed or reported first. **Safe to share**: the whole db:doctor output.

## 4. Migrate (your computer)

```bash
pnpm db:migrate:prod --confirm <project-ref>
```

It asks (prompts that do not echo) for the owner connection string and its password, then for
`APP_WEB_PASSWORD`, `APP_PAY_PASSWORD` and `APP_JOBS_PASSWORD` from your password manager (paste
each; empty keeps the current one). It prints the plan, asks you to type the project ref again, installs `btree_gist` and `pgcrypto` in
the `extensions` schema, applies each migration in its own transaction, clears the API roles,
sets the three login passwords (sent as salted verifiers; never printed), and runs the doctor.
Expect **0 FAIL**. Re-running later applies only new migrations. **Safe to share**: the whole output.

Then close the terminal (if you read any of them into the environment:
`unset DATABASE_URL_OWNER APP_WEB_PASSWORD APP_PAY_PASSWORD APP_JOBS_PASSWORD`).

## 5. Vercel settings and environment variables

Project → Settings:

- **General** → *Root Directory*: `apps/web`; *Include files outside the root directory*: on;
  *Framework*: Next.js; *Node.js Version*: 22.x.
- **Functions** → *Function Region*: Mumbai, `bom1` (`apps/web/vercel.json` also says so).
- **Environment Variables**: add the table below for **Production only**. Do not give them to
  *Preview* or *Development*: a preview deployment must never talk to the production database
  (without the variables a preview refuses to start, which is what we want).

| Name | Value comes from | Notes |
|---|---|---|
| `AUTH_PROVIDER` | the word `supabase` | |
| `APP_ORIGIN` | your origin, `https://...`, no trailing slash | must match Supabase *Site URL* |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` | |
| `SUPABASE_PUBLISHABLE_KEY` | Supabase → API Keys (2.5) | `sb_publishable_...` |
| `SUPABASE_SECRET_KEY` | Supabase → API Keys (2.5) | `sb_secret_...`; server-only |
| `DATABASE_URL_WEB` | transaction pooler string (2.2), user `app_web.<project-ref>`, password `APP_WEB_PASSWORD` | port 6543 |
| `DATABASE_URL_PAY` | same, user `app_pay.<project-ref>`, password `APP_PAY_PASSWORD` | port 6543 |
| `DATABASE_URL_JOBS` | same, user `app_jobs.<project-ref>`, password `APP_JOBS_PASSWORD` | port 6543 |
| `DATABASE_CA_CERT` | the CA file as one line: macOS `base64 -i prod-ca-2021.crt`, Linux `base64 -w0 prod-ca-2021.crt` | not secret |
| `IDENTITY_KEY` | step 1 | **never change** |
| `CARD_KEY` | step 1 | **never change** |
| `PIN_PEPPER` | step 1 | **never change** |
| `FIELD_KEY` | step 1 | **never change** |
| `JOBS_SIGNING_KEY` | step 1 | also goes to GitHub (section 8) |
| `ANALYTICS_KEY` | step 1 | optional (no key: no analytics) |
| `CRON_SECRET` | step 1 | Vercel Cron sends it as a bearer |
| `TRUSTED_PROXY_HOPS` | the number `1` | Vercel's edge sets X-Forwarded-For |
| `TURNSTILE_SITE_KEY` | Cloudflare → Turnstile (2.7) | public: sent to browsers |
| `TURNSTILE_SECRET_KEY` | Cloudflare → Turnstile (2.7) | **server-only**; required in production with Supabase |

Never set in Vercel: `DATABASE_URL_OWNER` (owner only, on your computer), `AUTH_PROVIDER=dev`,
`RATE_LIMIT_MULTIPLIER`, `DEV_GEO`, `DATABASE_TLS=disable`, `TURNSTILE_VERIFY_URL` (local tests
only). `CAPTCHA=off` only in an emergency (Cloudflare down for hours): it removes the bot protection
and the health page warns. The app refuses to start with most of
them in production, and the build fails if a secret ever appears in browser code.

`GEO_SOURCE` needs no value on Vercel (it defaults to `vercel`).

## 6. Deploy and check

1. Vercel → Deployments → *Redeploy* (or push to the production branch).
2. Open `https://<origin>/api/health`. Expect `{"ok":true,"version":"0.0.0","commit":"<12 hex>"}`.
3. Open the site, sign in with your own email (link or code), then with Google.
4. Finish the phone step (a text message in `sms` mode, none in `unverified` mode).
5. Make yourself the Super Admin (your computer, section 7).
6. Open `https://<origin>/api/v1/admin/health` while signed in. Check: `authProvider: "supabase"`,
   `databaseTls: "verify-full"`, `databaseCaPinned: true`, `serverless: true`, `jobsEnabled: true`,
   `dailyCronEnabled: true`, `trustedProxyHops: 1`, the latest `migrationVersion`, your
   `phoneVerification` choice, `captcha: "on"` and `warnings: []`. **Safe to share**: the whole JSON.
7. Buy something with your fictional money.

Session lifetime (default 7 days) can be changed by the owner in the SQL editor:
`UPDATE core.deployment_setting SET value = '86400' WHERE key = 'auth.session_max_age_seconds';`
(300 to 7776000 seconds).

## 7. First Super Admin (your computer)

After you signed in once and finished the phone step:

```bash
export DATABASE_CA_CERT_FILE=~/Downloads/prod-ca-2021.crt
pnpm admin:grant --confirm <project-ref>
```

It asks for the owner connection string and password, `IDENTITY_KEY` (the same value as in Vercel)
and the email address, all at prompts that do not echo, then the project ref again. It never prints or stores the email or the key. There is only
ever one Super Admin; running it for another email moves the role. **Safe to share**: its output.

## 8. Scheduled jobs

- **Daily (Vercel Cron)**: `apps/web/vercel.json` calls `GET /api/cron/daily` once a day (Hobby
  allows one run per day per job, at a time Vercel picks within the hour). It works as soon as
  `CRON_SECRET` and `JOBS_SIGNING_KEY` are set.
- **Every 10 minutes (GitHub Actions, free)**: listing screening and the stuck-session watchdog need
  more than daily. GitHub → the repository → Settings → *Secrets and variables* → *Actions* → *New
  repository secret*: add `DELULU_APP_ORIGIN` (your https origin) and `DELULU_JOBS_SIGNING_KEY` (the
  same value as `JOBS_SIGNING_KEY`). The workflow `.github/workflows/jobs-scheduler.yml` then runs
  every 10 minutes (GitHub may delay or skip scheduled runs under load; every job is safe to run
  late, twice, or not at all for a while). Actions → *jobs-scheduler* → *Run workflow* runs it now.
  The run's log shows only `HTTP <status>; listings screened: <n>`, never the job report. Keep the
  repository **private** if you can (a public repository's Actions logs are public); the workflow has
  no `pull_request` trigger (a fork's pull request can never run it with your secrets) and its token
  has no permissions.
- Check: `/api/v1/admin/health` → `jobsLastRunAt` moves forward.

## 9. Verify on first deploy

Everything below was built from documented behaviour and tested against local stand-ins, not the
real services. Check each once; `pnpm db:doctor` and `/api/v1/admin/health` cover the marked ones.

1. (doctor) The project's `postgres` user has CREATEROLE, owns the database, and holds at least
   one privilege on **every** table and sequence in `auth` (migrations 0001 and 0047 revoke on all
   of them and fail with "permission denied" otherwise), SELECT on `auth.users` / `auth.sessions`,
   REFERENCES on `auth.users`.
2. (doctor) `auth.users` has `id, banned_until, deleted_at, phone, phone_confirmed_at, is_anonymous, created_at`;
   `auth.sessions` has `id, user_id, not_after, created_at`.
3. (doctor) `postgres` may DELETE from `auth.sessions` (WARN if not: sign-out still works through
   `core.ended_session`, the Supabase row stays).
4. (doctor) `postgres` is a member of `pg_signal_backend` and `pg_read_all_stats` (the stuck-session
   watchdog needs both); advisory-lock functions cannot be revoked by a non-superuser (WARN expected).
5. (doctor) `btree_gist` / `pgcrypto` end up in `extensions`; app roles can still create temporary
   tables if `postgres` does not own the database (WARN).
6. The custom logins `app_web.<ref>` etc. connect through the **transaction pooler** (Supavisor) and
   keep their role settings (`statement_timeout` shows in the doctor's `login.*` lines).
7. TLS verification with Supabase's CA certificate succeeds for the pooler host name
   (`databaseCaPinned: true` and pages load).
8. Supabase accepts `code_challenge_method: "s256"` on `/otp` and `/authorize`, and redirects to
   `…/api/v1/auth/callback/<state>?code=…` when the redirect URL pattern `…/callback/**` is allowed.
   If you land on the home page with `?code=` in the address bar, the redirect URL is not allowed.
9. `POST /auth/v1/verify` with `type: "email"` and the typed code returns a session even for a sign-in
   that was started with PKCE.
10. Admin endpoints accept the new `sb_secret_...` key in the `apikey` header alone (no
    `Authorization` header).
11. Supabase does not end sessions on its own on the free plan (the app's 7-day limit applies), and
    an access token's `session_id` equals the `auth.sessions.id` the database sees.
12. Phone (`sms` mode): `PUT /admin/users/{id}` with `{phone}` sets an unconfirmed number; `/otp`
    with `create_user: false` texts that user; `/verify` `type: "sms"` sets `phone_confirmed_at` and
    returns a new session, which the app ends at once through `/logout?scope=local`.
13. Vercel overwrites `X-Forwarded-For` with the client address (hence `TRUSTED_PROXY_HOPS=1`);
    `x-vercel-ip-*` headers carry the place (analytics).
14. Vercel Hobby: one cron run per day; `maxDuration = 60` is allowed for the cron route.
15. The build finds the workspace packages with Root Directory `apps/web` (pnpm 10 from
    `packageManager`; if Vercel uses another pnpm, set the env var `ENABLE_EXPERIMENTAL_COREPACK=1`).
16. Supabase's per-IP auth rate limits see Vercel's addresses, not the players': if sign-ins start
    failing with "too many", raise them (2.4).
17. Deleting a user in the Supabase dashboard fails while they have a DeluluMart profile (a foreign
    key protects the ledger): **ban** users instead (Authentication → Users → … → Ban), which signs
    them out on their next request.
18. Supabase links a Google identity to an existing email account with the same verified address
    automatically; the app treats them as one account.
19. **Both** email templates (*Magic Link* and *Confirm signup*) carry the app's
    `{{ .SiteURL }}/sign-in/confirm?token_hash={{ .TokenHash }}&type=email` link and `{{ .Token }}`:
    sign in once with a NEW address and once with an existing one; each email has both, the link
    opens the page with the **Sign in** button, and pressing it signs in.
20. **Which template new `/otp` users get**: the first email to a new address is the *Confirm signup*
    template (not *Magic Link*); check that it arrives with the code and the app's link (19).
21. **`/verify` with `type: "email"`** returns a session both for a typed code and for a
    `token_hash`, also for a sign-in started with PKCE (`code_challenge` on `/otp`). If the link
    fails but the code works, try `type=magiclink` in the template for existing users and
    `type=signup` in *Confirm signup* (the app accepts all three).
22. **Link scanners**: forward a sign-in email through a scanning mail service (e.g. a work
    Microsoft 365 or Gmail account) and check the link still signs in after the scanner opened it
    (it only opens the page; nothing is redeemed on a GET).
23. **Automatic identity linking with unconfirmed emails** (pre-account takeover): with *Confirm
    email* on, create a password user for an address you own through Supabase's API without
    confirming it, then sign in with Google for that address: the two must NOT be merged into one
    account that the password holder can use. Keep *Confirm email* on, *Manual linking* off,
    *Anonymous sign-ins* off; the app refuses sessions it did not create (0074).
24. **Admin PUT phone conflict behaviour**: `PUT /admin/users/{id}` with another user's number
    answers 422 (the app then releases only an UNCONFIRMED hold older than 10 minutes and retries);
    `PUT` with `{"phone": ""}` clears an unconfirmed number. Check in Authentication → Users that a
    released number disappears from the squatting user; if Supabase ignores the empty number, the
    logs show `[auth] phone hold not released` and the number stays held until you remove it there.
25. **Per-IP limits vs Vercel egress**: Supabase counts every user against Vercel's few outbound
    addresses (2.4); raise its limits and use custom SMTP before real traffic.
26. **X-Forwarded-For overwrite**: Vercel replaces (does not append to) a client-sent
    `X-Forwarded-For`, so `TRUSTED_PROXY_HOPS=1` reads the real client address: send a request with
    a forged `X-Forwarded-For: 1.2.3.4` and check (rate limits, analytics place) that it is ignored.
27. **`app_*` logins through the pooler**: `app_web.<ref>`, `app_pay.<ref>` and `app_jobs.<ref>`
    log in through the transaction pooler (port 6543) with their own passwords and keep their role
    settings (doctor `login.*` lines).
28. **`postgres` can DELETE `auth.sessions`** (doctor item 3; WARN is acceptable) and can SELECT
    `auth.users.phone` / `phone_confirmed_at` (the phone-holder lookup of 0075 needs it).
29. **Repository visibility for Actions logs**: the repository is private, or you accept that the
    jobs-scheduler log (status and one count only) is public.
30. **Turnstile**: the widget loads on `/sign-in` (CSP allows `https://challenges.cloudflare.com` for
    scripts and frames on the challenge pages only), Cloudflare's siteverify answers your host name
    and the action (`email_start`, `email_verify`, `phone_code`), and Supabase's own captcha is off.

## 10. Errors and what to send back

| You see | It means | Send back (safe) |
|---|---|---|
| doctor/migrate: `password authentication failed` | wrong password in `DATABASE_URL_OWNER` | nothing; fix the password |
| `could not reach the database` | network, or the IPv6-only direct host | use the Session pooler string |
| `the server certificate is not trusted` | CA file missing or wrong | re-download (2.1), set `DATABASE_CA_CERT_FILE` |
| `Migration 00xx_... failed: permission denied for ...` | a privilege Supabase did not give `postgres` | the whole output |
| `FAIL api.*` | an API role can still read app tables | the whole doctor output |
| Vercel build: `check-client-bundle: server secrets found` | a server value reached browser code | the build log lines (they name files, not values) |
| Vercel function log: `Invalid server configuration ...: X is required` | a missing or malformed variable `X` | that line (it never contains values) |
| "That sign-in link did not work" after pressing **Sign in** | link expired, used twice, opened in another browser, or a token check failed | the Vercel log lines starting `[auth]` |
| Sign-in or phone step: "Complete the check below" | Turnstile token missing, expired or refused | the Vercel log lines starting `[captcha]` |
| Phone step: "We couldn't send a code to that number right now" | the number is held by another account, a text limit, or the SMS provider refused | the `[auth] phone code not sent` log lines (they name a reason, never a number) |
| `/sign-in?error=busy` | Supabase or the database did not answer | the `[auth]` / `[db:...]` log lines |
| Log `[auth] access token refused KEY` | JWKS unreachable or a key id the project does not publish | that line; check JWT Keys (2.4) |
| Log `[auth] access token refused ISSUER` / `AUDIENCE` | `SUPABASE_URL` differs from the project | check `SUPABASE_URL` |
| Log `[auth] session not live in the database` | the database cannot read `auth.sessions` or the user is banned | doctor output |
| Log `[auth] sign-in email not sent 4xx` | Supabase refused to send (rate limit, SMTP) | that line |
| `/api/cron/daily` 401 | `CRON_SECRET` missing or different | nothing |
| jobs workflow `HTTP 403` | key mismatch or clock skew > 60 s | the workflow log |

Never share: any connection string, password, key, `sb_secret_...`, `CRON_SECRET`, cookie value,
or a full Vercel environment export.

## 11. Backup and rotation of keys

- Keep the four never-change keys in two independent places (password manager + an offline copy).
  Losing them loses data; leaking them weakens fingerprints and encryption (rotation of those is a
  data migration, not a setting).
- **Database passwords**: generate new ones, run `pnpm db:migrate:prod --confirm <ref>` with the new
  `APP_*_PASSWORD` values, update the three Vercel URLs, redeploy.
- **Supabase secret key**: create a new secret key, update `SUPABASE_SECRET_KEY`, redeploy, then
  delete the old key in Supabase.
- **JOBS_SIGNING_KEY**: change it in Vercel and in the GitHub secret at the same time.
- **CRON_SECRET**, **ANALYTICS_KEY** (analytics visitor keys restart): change and redeploy.
- **TURNSTILE_SECRET_KEY**: Cloudflare → Turnstile → the site → *Rotate secret key*; put the new one
  in Vercel and redeploy (Cloudflare keeps the old one valid for a while).
- **JWT signing key**: rotate in Supabase (create standby key → make it current); the app re-reads
  the public keys within minutes. Revoke the old key only after an hour (signed-in sessions are not
  affected: the app does not keep tokens).
- The free plan has no backups: export regularly (Database → Backups is a paid feature; use
  `pg_dump` with the Session pooler string from your computer, encrypt the file).

## 12. Rollback

- **App**: Vercel → Deployments → pick the last good one → *Promote to Production* (instant).
- **Database**: migrations are forward-only; a failed migration rolls itself back and stops the run.
  Do not edit or delete applied migrations; fix forward with a new one. Earlier app versions keep
  working with later migrations (they only add).
- **Phone mode / session lifetime**: the SQL in sections 2.6 and 6.
- **Emergency stop of sign-ins**: Supabase → Authentication → turn off *Allow new users to sign up*
  and the providers; existing sessions keep working until they end.

## 13. Recommended next

- Custom SMTP for sign-in emails (required before real traffic, 2.4); a custom domain.
- An uptime monitor on `/api/health`.
