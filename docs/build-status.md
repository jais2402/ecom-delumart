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
node tests/a11y/audit.js
```

## What works end to end, locally

**Buying.** A person can sign in, verify a phone number, enter a date of birth, receive ₹100 crore, set a card PIN, browse and search products, add several to a cart (signed out or in), choose delivery per seller, pay by card with PIN or from bank balance, see a receipt and delivery timeline, and find the order, the statement entry and the item in their account. They can freeze the card, change the PIN, edit their profile, save products, report a listing and block a shop.

**Selling.** A person can unlock creator access by spending or by passing the passport quiz, claim relief, register a shop with a handle, create and submit listings, have them screened by the jobs process and published, set stock, create public and private coupons, and see orders, earnings and inventory in the merchant portal. They can appeal a hidden listing.

**Super Admin.** The console shows the moderation queue, report cases, appeals, the publication switch and an overdue banner.

## Built and verified

| Area | What exists | Evidence |
|---|---|---|
| Design system (Daydream) | Tokens for light and dark; atoms, molecules, organisms and page layouts following atomic design | 324 component tests; scripted accessibility audit with 0 issues |
| Domain logic (`core`) | Money, the pricing function, card numbers, PIN rules, identity, delivery schedule, progression, passport quiz, text screening, handle rules including look-alike checks, listing rules | 267 unit and property tests |
| Database (`db`) | 51 migrations. Ledger with zero-sum, append-only and sealing rules; row-level security on every table; application roles with no direct writes to money, order, stock or identity tables; all commands as owner-defined functions; acting user derived from a live sign-in session | 678 tests on PostgreSQL, including attack-replay suites from six review rounds |
| Money path | Provisioning, checkout and all-or-nothing pay for multi-seller carts with merchant coupons, stock units, ownership, shipments, creator unlock, relief, company registration, idempotency, per-actor limits | Race tests (last unit, overspend, same key ×10, coupon cap) |
| Card PIN | Set, change, reset and verify inside the database with limits and lockout; the database never sees a PIN | PIN suite including parallel guesses |
| Cart | Storage, add, remove, clear, sign-in merge, priced preview sharing one pricing path with checkout | 50-random-cart preview-equals-checkout test |
| Selling | Passport (quiz graded in the database), shop registration with handle reservation, listing drafts, append-only submission log with a daily cap, screening job, publishing, stock, merchant coupons, seller order and earnings views that do not identify buyers | Listing, company, coupon and merchant suites |
| Safety | Reports with reporter standing, clearances after dismissal or upheld appeal, limits on automatic hiding, appeals, blocks, moderation overdue status | Report-abuse replay tests |
| Jobs | Signed, replay-protected jobs endpoint; the jobs database role has no direct table access and works only through seven narrow functions; watchdog with a 5-second floor | Generated privilege test over every application table |
| Web server | Typed configuration with server-only secrets, separate database pools per role, opaque session cookie, session-bound CSRF token and origin check, uniform error envelope, database-backed rate limits, content security policy with per-request nonce, private pages uncacheable | 316 web tests against PostgreSQL; production build checked for secrets in browser code |
| Screens | Storefront, sign-in and onboarding, cart, checkout, receipt and tracking, account, selling hub, passport, shop registration, public shop page, studio (products, orders, earnings, inventory, coupons, appeals), console (moderation, reports) | Five browser journeys (21, 19, 15, 17 and 15 steps) at phone width |
| Process | Standards, test catalogue, review mechanism, project agents with model tiers | `docs/engineering-standards.md`, `CLAUDE.md`, `.claude/agents/` |

Total: 1,585 automated tests passing; lint, typecheck and production build clean.

## Security review history

Six independent adversarial reviews, each followed by a fix round with tests that replay the attacks.

| Round | Outcome |
|---|---|
| 1 | Blockers: minting, seller-to-self transfers, forged quotes, direct order writes |
| 2 | Blocker: self-declared company scope; stale-price purchases; relief re-dating |
| 3 | Blocker: early-firing checks then extra rows; second grant via planted profile |
| 4 | No blocker. Majors: lock-holding denial of service, coupon guessing, unbounded attempts, over-powerful jobs role |
| 5 | No blocker. Majors: open redirect after sign-in, advisory-lock denial of service, no content security policy, rate-limit bypass |
| 6 | No blocker. Majors: three accounts could repeatedly hide any listing, submission cap bypass by deleting drafts, over-powerful jobs credential, one stale listing paused publishing platform-wide |

**The seventh fix round (after review 6, migrations 0044–0051) has not itself been independently reviewed.**

## Not built

| Area | Missing |
|---|---|
| Real sign-in | The Supabase provider is a stub that throws. Local development uses a dev-only provider that refuses to load in production. Google sign-in, real email links and SMS verification are not connected. |
| Deployment | Nothing is hosted. No job runner is scheduled, so screening, the watchdog, purges and the moderation overdue check do not run on their own. |
| Back office and analytics | Console configuration areas (catalogue, delivery, payments, platform coupons), the analytics engine, dashboards and usage by place |
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
- **One browser journey (`selling.spec`) timed out once** in a round 7 run and passed on every re-run; treated as flaky, cause not found.
- **Design document drift.** `system-design/low-level-design.md` predates much of the code; the migrations and tests are the source of truth.
- **Product art** is generated illustration, a placeholder.
