# Build status

What exists in the codebase, what has been verified, and what is not built. Updated 20 November 2026 after the first build session.

## How to check it yourself

```bash
pnpm install
```

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

```bash
pnpm dev
```

Database tests need PostgreSQL 16 reachable at `DATABASE_URL` (see `.env.example`). Then open `http://localhost:3000` and `http://localhost:3000/design-system`.

## Built and verified

| Area | What exists | Evidence |
|---|---|---|
| Workspace | pnpm monorepo: `apps/web`, `packages/ui`, `packages/core`, `packages/db`; Biome, Vitest, CI workflow | Lint, typecheck and build pass |
| Design system (Daydream) | Tokens for light and dark; 24 atoms, 20 molecules, 17 organisms, 6 layout templates, atomic import direction | 209 component tests; scripted accessibility audit clean on five pages at two widths in both themes |
| Storefront pages | Home, six category pages, 60 product pages, search, design-system showcase, on seed data | 71 pages build; rendered and looked at on desktop and phone |
| Seed content | 60 imaginary products in six categories; 24 fictional localities and landmarks | Counts, unique ids and price range checked |
| Domain logic (`core`) | Money formatting, pricing function, card numbers, PIN rules and attempt counters, identity normalisation and fingerprints, adult check, delivery schedule, creator/brand/collector rules, experiment assignment | 111 unit and property tests; independent review, findings fixed |
| Database (`db`) | 17 migrations: roles, schemas, all core tables, ledger with zero-sum and append-only enforcement, row-level security on every table, per-role grants, structural money rules | 288 tests against PostgreSQL, including privilege, row-level-security and attack-replay suites |
| Account provisioning | One transaction: profile, bank account, wallet, ₹100 crore starter grant, card; idempotent under concurrency; no repeat grant for a deleted identity | Concurrency tests (ten and twenty simultaneous calls) |
| Checkout and payment | Quote, payment attempt, all-or-nothing pay for multi-seller carts with merchant coupons, stock units, ownership, shipments, creator unlock, idempotency, canonical lock order | Functional tests for the PRD examples; race tests (last unit, overspend, same key ×10, coupon cap); two rounds of independent security review with three rounds of fixes. **The third round of fixes has not itself been independently reviewed.** |
| Engineering process | Standards, test catalogue, review mechanism, five project agents with explicit model tiers, agent instruction file | `docs/engineering-standards.md`, `CLAUDE.md`, `.claude/agents/` |

## Not built

Nothing below exists yet. The order follows `docs/execution-plan.md`.

| Area | Missing |
|---|---|
| Wiring | The web app is not connected to the database or to sign-in. Pages show seed data; "Add to cart" is disabled. There are no API routes. |
| Identity | Sign-in (email link, Google), phone verification, birthdate capture, sessions, encrypted personal fields |
| Payments | PIN and bank-code verification wired into the card and net-banking paths; DeluluPay ID and net-banking methods; platform coupons; company registration, warehouse and membership checkouts |
| Shopping | Cart storage, addresses, tracking page, collection, saves, receipts, share cards, caching layer |
| Selling | Unlock by passport, relief claim command, company registration, studio, publishing with stock allocation, moderation queue, reports, appeals |
| Merchant portal | All of it |
| Back office and analytics | All of it: Super Admin, dashboards, metric engine, place analytics, delayed actions |
| Later phases | Brand teams, extra warehouses, collector UI, NPC sandbox, experiments, research dataset |
| Operations | Job runner, outbox consumers, reconciliation job, backups, deployment, monitoring |
| Legal | Privacy notice, terms, research wording |

Against the nine-phase plan, this session completed Phase 0 and the guarded core of Phases 1 and 2 (ledger, provisioning, pricing, pay), plus the design system and public storefront pages. It did not complete any phase end to end, because every phase needs sign-in and the web-to-database wiring.

## Known limits of what was built

- **Acting-user trust (must be closed before any real user).** Every "who is acting" check in the database reads a setting the application supplies. With the payment credential stolen, an attacker could name any user as the actor and spend their balance, or provision invented users and collect starting grants. The planned fix needs sign-in: the database verifies a session token signed by the sign-in service (the web process holds only the public key), and profiles reference the sign-in service's user table. It is documented at the top of `packages/db/migrations/0011_grants.sql` and appears as three `todo` tests in every run.
- **Trust boundary.** The web application holds both the ordinary and the payment database credentials. The role split stops injected queries from touching money tables; the structural rules bound what a stolen payment credential can do (no minting outside fixed grants, no underpricing, no redirecting proceeds), subject to the point above.
- **Timeouts** set on database roles can be overridden by a session that holds the credential, so they limit accidents and casual abuse of locks, not a determined attacker.
- **Card PIN.** The function that marks a card payment as authenticated trusts its caller; PIN verification is implemented as pure logic in `core` but not connected.
- **Not database-enforced:** PIN checks, address ownership, cart line limits, the configured coupon percent range, and idempotency. Company registration, warehouse and membership payments are blocked entirely until their backing tables and checks are built.
- **Design document drift.** The SQL in `system-design/low-level-design.md` predates the migrations; the migrations are the source of truth.
- **Product art** is generated geometric illustration, a placeholder for real artwork.
- **Not exercised:** load testing, end-to-end browser journeys through a live backend, a restore drill, and deployment. None of these is possible until the app is wired and hosted.
