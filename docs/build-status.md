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
| Database (`db`) | 16 migrations: roles, schemas, all core tables, ledger with zero-sum and append-only enforcement, row-level security on every table, per-role grants, structural money rules | 254 tests against PostgreSQL, including privilege, row-level-security and attack-replay suites |
| Account provisioning | One transaction: profile, bank account, wallet, ₹100 crore starter grant, card; idempotent under concurrency; no repeat grant for a deleted identity | Concurrency tests (ten and twenty simultaneous calls) |
| Checkout and payment | Quote, payment attempt, all-or-nothing pay for multi-seller carts with merchant coupons, stock units, ownership, shipments, creator unlock, idempotency, canonical lock order | Functional tests for the PRD examples; race tests (last unit, overspend, same key ×10, coupon cap); two rounds of independent security review |
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

- **Trust boundary.** The web application holds both the ordinary and the payment database credentials. The role split stops injected queries from touching money tables; the structural rules are what hold if the web process itself is taken over. Row-level security depends on the application setting the acting user honestly.
- **Card PIN.** The function that marks a card payment as authenticated trusts its caller; PIN verification is implemented as pure logic in `core` but not connected.
- **Not database-enforced:** prices of company registration, warehouse and membership purchases (no order rows exist for them yet), how a flat coupon is split across lines (totals and caps are checked), and idempotency.
- **Design document drift.** The SQL in `system-design/low-level-design.md` predates the migrations; the migrations are the source of truth.
- **Product art** is generated geometric illustration, a placeholder for real artwork.
- **Not exercised:** load testing, end-to-end browser journeys through a live backend, a restore drill, and deployment. None of these is possible until the app is wired and hosted.
