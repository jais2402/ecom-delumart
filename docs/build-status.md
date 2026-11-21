# Build status

What exists in the codebase, what has been verified, and what is not built. Updated 21 November 2026.

## How to check it yourself

PostgreSQL 16 must be running locally and reachable as in `.env.example`.

```bash
pnpm install
```

```bash
pnpm dev:setup
```

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

```bash
pnpm dev
```

`pnpm dev:setup` migrates and seeds a local database and prints the lines for `apps/web/.env.local`. Run it again after `pnpm --filter @delulu/db test`. Then open `http://localhost:3000`. Sign-in in local development needs no email: enter any address; the phone code is `000000`.

Browser journeys (with the dev server running):

```bash
node tests/e2e/journey.spec.mjs
```

```bash
node tests/e2e/cart.spec.mjs
```

```bash
node tests/a11y/audit.js
```

## What works end to end, locally

A person can sign in, verify a phone number, enter a date of birth, receive ₹100 crore, set a card PIN, browse and search 60 products, add several to a cart (signed out or in), choose delivery per seller, pay by card with PIN or from bank balance, see a receipt and delivery timeline, and find the order, the statement entry and the item in their account. They can freeze the card, change the PIN and edit their profile.

## Built and verified

| Area | What exists | Evidence |
|---|---|---|
| Design system (Daydream) | Tokens for light and dark; atoms, molecules, organisms and page layouts following atomic design | 251 component tests; scripted accessibility audit with 0 issues |
| Domain logic (`core`) | Money formatting, the pricing function, card numbers, PIN rules, identity normalisation, adult check, delivery schedule, progression rules, experiment assignment | 111 unit and property tests |
| Database (`db`) | 31 migrations. Ledger with zero-sum, append-only and sealing rules; row-level security on every table; application roles with no direct writes to money, order, stock or identity tables; all commands as owner-defined functions; acting user derived from a live sign-in session | 496 tests on PostgreSQL, including attack-replay suites from five review rounds |
| Money path | Provisioning with the starter grant, checkout and all-or-nothing pay for multi-seller carts with merchant coupons, stock units, ownership, shipments, creator unlock, idempotency, per-actor limits | Race tests (last unit, overspend, same key ×10, coupon cap); reconciliation clean after review runs |
| Card PIN | Set, change, reset and verify inside the database with per-attempt and per-card limits and lockout; the database never sees a PIN | PIN suite including parallel guesses |
| Cart | Storage, add, remove, clear, sign-in merge, per-line status, priced preview sharing one pricing path with checkout | 50-random-cart preview-equals-checkout test; 30 concurrent adds never exceed 20 lines |
| Web server | Typed configuration with server-only secrets, separate database pools per role, opaque session cookie, session-bound CSRF token and origin check, uniform error envelope, database-backed rate limits, content security policy with per-request nonce, private pages uncacheable | 240 web tests against PostgreSQL; production build checked for secrets in browser code |
| Screens | Storefront, sign-in and onboarding, cart, checkout, order receipt and tracking, account (overview, orders, wallet, cards, collection, profile) | Two browser journeys (21 and 19 steps) at phone width |
| Process | Standards, test catalogue, review mechanism, project agents with model tiers | `docs/engineering-standards.md`, `CLAUDE.md`, `.claude/agents/` |

Total: 1,098 automated tests passing; lint, typecheck and production build clean.

## Security review history

Five independent adversarial reviews, each followed by a fix round with tests that replay the attacks.

| Round | Outcome |
|---|---|
| 1 | Blockers: minting, seller-to-self transfers, forged quotes, direct order writes |
| 2 | Blocker: self-declared company scope; stale-price purchases; relief re-dating |
| 3 | Blocker: early-firing checks then extra rows; second grant via planted profile |
| 4 | No blocker. Majors: lock-holding denial of service, coupon guessing, unbounded attempts, over-powerful jobs role |
| 5 | No blocker. Majors: open redirect after sign-in, advisory-lock denial of service, no content security policy, rate-limit bypass |

**The sixth fix round (after review 5) has not itself been independently reviewed.**

## Not built

| Area | Missing |
|---|---|
| Real sign-in | The Supabase provider is a stub that throws. Local development uses a dev-only provider that refuses to load in production. Google sign-in, real email links and SMS verification are not connected. |
| Deployment | Nothing is hosted. No job runner is scheduled, so the stuck-session watchdog, rate-counter purge, reconciliation and notifications do not run on their own. |
| Selling | Unlock by passport, relief claim, company registration, studio, publishing, moderation queue, reports, appeals. No screen creates a shop or a coupon. |
| Merchant portal, back office, analytics | All of it, including Super Admin and dashboards |
| Payments | DeluluPay ID and net banking methods, platform coupons, membership, company and warehouse purchases, reversals |
| Shopping extras | Saves, public shelf, share cards, real addresses (checkout uses no address yet), Express on seed products |
| Later phases | Brand teams, extra warehouses, collector screens, NPC sandbox, experiments, research dataset |
| Legal | Privacy notice, terms, research wording |

## Known limits

- **Trust in the web server.** The database derives the acting user from a live session id, so a stolen database credential alone cannot act as another user. A fully compromised web server still sees the session ids of users active through it.
- **Phone and age facts** are asserted by the web server until the real sign-in service confirms phone numbers itself.
- **Public pages are rendered per request** since the content security policy was added, so they are no longer cached at the edge for 60 seconds; the public catalog API still is. Page-level caching needs revisiting before real traffic.
- **Lock-holding denial of service** by someone with the payment database credential is bounded by a watchdog, not eliminated, and the watchdog needs scheduling in production.
- **Role-level timeouts and the advisory-lock revoke** depend on the production database owner's privileges; the row locks and watchdog cover the case where they do not apply.
- **Not exercised:** load testing, a restore drill, deployment, real Supabase, coupons and self-purchase through the web app, two-seller carts in the browser.
- **Design document drift.** `system-design/low-level-design.md` predates much of the code; the migrations and tests are the source of truth.
- **Product art** is generated illustration, a placeholder.
