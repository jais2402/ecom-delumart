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
node tests/e2e/selling.spec.mjs
```

```bash
node tests/e2e/studio.spec.mjs
```

```bash
node tests/e2e/merchant.spec.mjs
```

```bash
node tests/e2e/analytics.spec.mjs
```

```bash
node tests/a11y/audit.js
```

## What works end to end, locally

**Buying.** A person can sign in, verify a phone number, enter a date of birth, receive ₹100 crore, set a card PIN, browse and search products, add several to a cart (signed out or in), choose delivery per seller, pay by card with PIN or from bank balance, see a receipt and delivery timeline, and find the order, the statement entry and the item in their account. They can freeze the card, change the PIN, edit their profile, save products, report a listing and block a shop.

**Selling.** A person can unlock creator access by spending or by passing the passport quiz, claim relief, register a shop with a handle, create and submit listings, have them screened by the jobs process and published, set stock, create public and private coupons, and see orders, earnings and inventory in the merchant portal. They can appeal a hidden listing.

**Super Admin.** The console shows the moderation queue, report cases, appeals, the publication switch and an overdue banner, and three analytics screens: an overview with trends and the purchase funnel, usage by place (country, region, city), and top products, shops and categories.

## Built and verified

| Area | What exists | Evidence |
|---|---|---|
| Design system (Daydream) | Tokens for light and dark; atoms, molecules, organisms and page layouts following atomic design | 345 component tests; scripted accessibility audit with 0 issues |
| Domain logic (`core`) | Money, the pricing function, card numbers, PIN rules, identity, delivery schedule, progression, passport quiz, text screening, handle rules including look-alike checks, listing rules | 310 unit and property tests |
| Database (`db`) | 57 migrations. Ledger with zero-sum, append-only and sealing rules; row-level security on every table; application roles with no direct writes to money, order, stock or identity tables; all commands as owner-defined functions; acting user derived from a live sign-in session | 814 tests on PostgreSQL, including attack-replay suites from seven review rounds |
| Money path | Provisioning, checkout and all-or-nothing pay for multi-seller carts with merchant coupons, stock units, ownership, shipments, creator unlock, relief, company registration, idempotency, per-actor limits | Race tests (last unit, overspend, same key ×10, coupon cap) |
| Card PIN | Set, change, reset and verify inside the database with limits and lockout; the database never sees a PIN | PIN suite including parallel guesses |
| Cart | Storage, add, remove, clear, sign-in merge, priced preview sharing one pricing path with checkout | 50-random-cart preview-equals-checkout test |
| Selling | Passport (quiz graded in the database), shop registration with handle reservation, listing drafts, append-only submission log with a daily cap, screening job, publishing, stock, merchant coupons, seller order and earnings views that do not identify buyers | Listing, company, coupon and merchant suites |
| Safety | Reports with reporter standing, clearances after dismissal or upheld appeal, limits on automatic hiding, appeals, blocks, moderation overdue status | Report-abuse replay tests |
| Analytics | Events with no user id, session, address or search text; a visitor key that rotates daily; place taken from the host's location headers; places under 10 daily visitors folded into their parent; daily rollups; money and order figures read from real tables, not browser events; opted-out accounts and browsers sending a do-not-track signal produce no events | Analytics suites in db and web; dashboards loaded as a real Super Admin against seeded data |
| Jobs | Signed, replay-protected jobs endpoint; the jobs database role has no direct table access and works only through seven narrow functions; watchdog with a 5-second floor | Generated privilege test over every application table |
| Web server | Typed configuration with server-only secrets, separate database pools per role, opaque session cookie, session-bound CSRF token and origin check, uniform error envelope, database-backed rate limits, content security policy with per-request nonce, private pages uncacheable | 361 web tests against PostgreSQL; production build checked for secrets in browser code |
| Screens | Storefront, sign-in and onboarding, cart, checkout, receipt and tracking, account, selling hub, passport, shop registration, public shop page, studio (products, orders, earnings, inventory, coupons, appeals), console (moderation, reports, analytics) | Six browser journeys (21, 19, 15, 17, 15 and 10 steps) |
| Process | Standards, test catalogue, review mechanism, project agents with model tiers | `docs/engineering-standards.md`, `CLAUDE.md`, `.claude/agents/` |

Total: 1,830 automated tests passing; lint, typecheck and production build clean.

## Security review history

Seven independent adversarial reviews, each followed by a fix round with tests that replay the attacks.

| Round | Outcome |
|---|---|
| 1 | Blockers: minting, seller-to-self transfers, forged quotes, direct order writes |
| 2 | Blocker: self-declared company scope; stale-price purchases; relief re-dating |
| 3 | Blocker: early-firing checks then extra rows; second grant via planted profile |
| 4 | No blocker. Majors: lock-holding denial of service, coupon guessing, unbounded attempts, over-powerful jobs role |
| 5 | No blocker. Majors: open redirect after sign-in, advisory-lock denial of service, no content security policy, rate-limit bypass |
| 6 | No blocker. Majors: three accounts could repeatedly hide any listing, submission cap bypass by deleting drafts, over-powerful jobs credential, one stale listing paused publishing platform-wide |

| 7 | One blocker: a shop could still be linked to its owner's user id through the listing-version table. Majors: one dismissed junk report gave a listing 30 days of immunity; seller order ids encoded the exact order time |

**The eighth fix round (after review 7, migrations 0053–0057) and the analytics engine (migration 0052) have not been independently reviewed.**

## Not built

| Area | Missing |
|---|---|
| Real sign-in | The Supabase provider is a stub that throws. Local development uses a dev-only provider that refuses to load in production. Google sign-in, real email links and SMS verification are not connected. |
| Deployment | Nothing is hosted. No job runner is scheduled, so screening, the watchdog, purges and the moderation overdue check do not run on their own. |
| Back office | Console configuration areas (catalogue, delivery, payments, platform coupons). Analytics has no hourly figures and no export. |
| Payments | DeluluPay ID and net banking methods, platform coupons, membership, warehouse purchases, reversals |
| Shopping extras | Public shelf, share cards, real addresses (checkout uses no address yet), Express on seed products |
| Later phases | Brand teams, extra warehouses, collector screens, NPC sandbox, experiments, research dataset |
| Legal | Privacy notice, terms, research wording |

## Known limits

- **Trust in the web server.** The database derives the acting user from a live session id, so a stolen database credential alone cannot act as another user. A fully compromised web server still sees the session ids of users active through it.
- **Phone and age facts** are asserted by the web server until the real sign-in service confirms phone numbers itself.
- **Public pages are rendered per request** since the content security policy was added, so they are no longer cached at the edge for 60 seconds; the public catalog API still is. Page-level caching needs revisiting before real traffic.
- **Lock-holding denial of service** by someone with the payment database credential is bounded by a watchdog, not eliminated, and the watchdog needs scheduling in production.
- **Role-level timeouts and the advisory-lock revoke** depend on the production database owner's privileges; the row locks and watchdog cover the case where they do not apply.
- **Screening verdicts** are decided by the jobs process outside the database, so a compromised jobs credential can still approve pending listing text. It can do nothing else.
- **Owner publishing while publication is off** stays blocked; only the Super Admin's approve and restore work during a pause.
- **Not exercised:** load testing, a restore drill, deployment, real Supabase, two-seller carts in the browser.
- **Usage by place needs the host's location headers,** which exist only once deployed on Vercel; locally everything is "Unknown location" unless `DEV_GEO` is set or synthetic data is seeded with `SEED_ANALYTICS=1 pnpm dev:setup`.
- **A seller's own database scope still includes the internal order ids** of its orders; no route returns them, so reaching them needs an injection on the web credential.
- **Browser journeys assume a fresh local database.** After many runs, test listings crowd seeded products off the first catalogue page and three journeys fail at setup; drop `delulu_dev` and run `pnpm dev:setup` again.
- **One browser journey (`selling.spec`) timed out once** in a round 7 run and passed on every re-run; treated as flaky, cause not found.
- **Design document drift.** `system-design/low-level-design.md` predates much of the code; the migrations and tests are the source of truth.
- **Product art** is generated illustration, a placeholder.
