# DeluluMart — instructions for coding agents

Pretend-commerce web app with fictional money. Read `docs/README.md` for the document map. The build reference is `docs/system-design/low-level-design.md`; the rules for how we work are in `docs/engineering-standards.md`; UI rules are in `docs/design-system.md`.

## Commands

```bash
pnpm install          # once
pnpm test             # all packages
pnpm typecheck        # all packages
pnpm lint             # biome check
pnpm format           # biome check --write
pnpm dev              # web app on :3000
pnpm --filter @delulu/core test     # one package
```

Run `pnpm typecheck && pnpm lint && pnpm test` before saying a change is done. Report failures as failures.

## Layout

| Path | Contents |
|---|---|
| `apps/web` | Next.js app (App Router). Pages only compose templates and organisms. |
| `packages/ui` | Daydream design system: `atoms/`, `molecules/`, `organisms/`, `templates/`, `styles/` |
| `packages/core` | Framework-free domain logic. Pure functions first. |
| `packages/db` | SQL migrations, migration runner, database tests |
| `docs` | PRD revision, system design, standards |

## Invariants — never break these

1. Money is integer paise as `bigint`. No `number` arithmetic on money, no floats, no `parseFloat`. JSON carries money as decimal strings.
2. Only the ledger module writes money tables. Every journal sums to zero. Ledger rows are never updated or deleted; corrections are new rows.
3. Every amount in a purchase comes from the single pricing function in `packages/core/src/pricing`.
4. Multi-row transactions take locks in the canonical order (low-level design §4).
5. Nothing cached or client-supplied ever authorises a payment, price, stock level or permission.
6. Public and private data never share a response. Anything behind a session is `private, no-store`.
7. No field anywhere accepts a real card number, expiry, CVV, UPI PIN or bank password. Card numbers are displayed, never typed.
8. No personal data (email, phone, birthdate, address, PIN, card number) in logs, analytics events, outbox payloads or test snapshots.
9. NPC code never imports or writes ledger, orders or inventory.
10. Every tunable number comes from configuration, not a literal in feature code.

## Zones

| Zone | Paths | Rule |
|---|---|---|
| Guarded | `packages/core/src/{ledger,pay,pricing,inventory,promotions,identity,policy}`, `packages/db/migrations` | Tests first. Small diffs. Needs human review before merge. Do not weaken a test to make it pass. |
| Fast | `packages/ui`, `apps/web` pages, content, styles | Generate freely; must pass type, lint, component and accessibility checks. |

## Conventions

- TypeScript strict. No `any`, no non-null `!` without a comment saying why. Named exports only.
- Errors: throw `DomainError` with a stable code from `packages/core/src/errors`; never throw strings.
- Files: `kebab-case.ts`; React components `PascalCase.tsx`, one component per file, colocated `*.test.tsx`.
- UI follows atomic design. Atoms import nothing from higher levels; molecules import atoms; organisms import molecules and atoms; templates import organisms. No data fetching below the page level.
- Use design tokens (CSS variables / Tailwind theme). No raw hex colours in components.
- Every interactive element is keyboard reachable, has a visible focus state and an accessible name.
- Tests name the requirement they cover where one exists, e.g. `it("US-41: merchant coupon ...")`.
- Do not add a dependency without stating why in the change description.
- Commit messages: `type(scope): summary` (`feat`, `fix`, `test`, `docs`, `refactor`, `chore`).

## When unsure

Prefer the low-level design over inventing. If the design is silent or contradictory, stop and say so rather than guessing in the guarded zone.
