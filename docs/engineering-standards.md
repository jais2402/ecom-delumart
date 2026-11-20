# DeluluMart — Engineering Standards

How the project is built: development approach, coding standards, testing, review, the skills and agents used, and how model and token cost is kept down. Short rules for coding agents are in `/CLAUDE.md`; this document is the reasoning and the detail.

Sources are listed at the end. Where a practice is my recommendation rather than an established standard, it says so.

---

## 1. Development approach

| Practice | What it means here | Why |
|---|---|---|
| Trunk-based development | Short-lived branches, merged to `main` at least every few days; `main` always deploys to staging | One person plus agents cannot afford long-lived divergent branches |
| Vertical slices | Each change delivers a thin, usable path from screen to database | Finds integration problems early; always demonstrable |
| Specification-driven | PRD acceptance criteria (US-xx) are turned into tests before or with the code | Gives agents an unambiguous target and gives you a completion check |
| Test-first in the guarded zone | Ledger, payments, pricing, stock, coupons, permissions, migrations: failing test first, then code | These are the paths where a mistake costs trust |
| Generate-then-verify in the fast zone | Screens, tables and forms are generated quickly, then held to automated checks | Speed where mistakes are cheap and visible |
| Configuration over constants | Fees, limits, thresholds live in versioned configuration | Economy changes without code changes; experiments reuse the same mechanism |
| Small, reversible changes | Backward-compatible migrations; feature switches; previous build redeployable | Rollback is the safety net when there is no second engineer |

---

## 2. Coding standards

**TypeScript**
- `strict` and `noUncheckedIndexedAccess` on. No `any`. No type assertions to silence errors.
- Named exports. One responsibility per module. Public surface of a package only through its `index.ts`.
- Parse external input at the boundary with a schema; inside the boundary, types are trusted.
- Domain code is pure where possible: inputs in, result out, no clock or randomness except through injected functions.

**Money and numbers**
- Money is `bigint` paise end to end. Division is explicit floor division with the rule stated in a comment.
- Display formatting only in the money formatter; never string-build amounts in components.

**Errors**
- One `DomainError` class carrying a stable code from a single list. Messages are for people; codes are for programs and tests.
- No silent catch. A caught error is handled, rethrown, or recorded with a reason.

**Database**
- Every table has row-level security and explicit grants in the same migration that creates it.
- Constraints first: if a rule can be a constraint, unique index or trigger, it is one.
- Migrations are forward-only and backward-compatible with the previous build.

**React and UI**
- Atomic design levels (see `design-system.md`). Server components by default; client components only for interactivity.
- No data fetching below page level. Components take data as props.
- Tokens only; no literal colours or pixel font sizes in components.
- WCAG 2.2 AA: keyboard path, visible focus, labelled controls, status announced, colour never the only signal, reduced motion respected.

**Security hygiene**
- No secrets in code or tests. No personal data in logs, events, snapshots or fixtures (use obviously fake values).
- All SQL parameterised. All user text escaped by the framework; no raw HTML injection.

**Formatting and linting**
- Biome for format and lint; the pipeline fails on any finding. No disabling a rule without a comment explaining why.

**Git**
- Commit messages `type(scope): summary`. One logical change per commit.
- Pull request description: what changed, which US-ids it covers, how it was verified, and any risk.

---

## 3. Testing strategy

The shape follows the "testing trophy": a wide base of static checks, most effort on integration tests, focused unit tests for pure logic, and a small number of end-to-end journeys. One addition specific to this product: a dedicated concurrency layer, because the worst bugs here are races.

| Layer | Tooling | What it covers | Target |
|---|---|---|---|
| Static | TypeScript, Biome, module-boundary check, secret and dependency scans | Types, style, forbidden imports, leaked secrets, known vulnerabilities | Zero findings |
| Unit and property | Vitest, fast-check | Pure functions: pricing, fees, card numbers, PIN rules, delivery stages, assignment, formatting | Every branch of guarded pure logic; properties for all invariants |
| Component | Vitest, Testing Library | Atoms to organisms: rendering, states, keyboard use, accessible names | Every component has at least render, interaction and accessibility assertions |
| Database integration | Vitest against real PostgreSQL | Constraints, triggers, grants, row-level security, each command's transaction | Every constraint has a test that tries to break it |
| Concurrency | Parallel transactions on real PostgreSQL | Double grant, double pay, overdraw, last unit, coupon cap, freeze versus pay | Every race listed in the low-level design §13 |
| Authorisation matrix | Generated from the route table | Every private route against every kind of actor | No route without an entry |
| End to end | Playwright, axe | Sign-up to delivery, each payment method, listing to sale, deletion | The journeys in PRD §7.2 |
| Non-functional | k6, page-speed profile, failure rehearsals | Latency targets, page budgets, the resiliency matrix | Before each cohort |

**Rules**
- A test states the requirement it covers: `it("US-03: same key returns the same order")`.
- Tests assert behaviour, not implementation. No snapshot of large markup.
- A failing test is fixed or the code is fixed. Tests are never deleted, skipped or loosened to get green.
- Fixtures use builders with obviously fake data. Time and randomness are injected.
- Property tests state the invariant in the test name.

### 3.1 Test-case catalogue (starting set)

Each row becomes one or more named tests. The full list of acceptance criteria is in the PRD (US-01 to US-32) and Revision 1.5 (US-33 to US-61).

| Area | Case | Layer |
|---|---|---|
| Money | Fee is `floor(5%)` for every price in range, at the ₹100 and ₹100 crore bounds | Property |
| Money | Any priced quote produces postings that sum to zero with no negative amount | Property |
| Money | Worked examples from Revision 1.5 R6.6 produce the exact postings | Unit |
| Money | Flat coupon split across lines sums exactly to the coupon value | Property |
| Money | Discounted price never falls below ₹100 | Property |
| Ledger | Inserting an unbalanced journal is rejected at commit | Database |
| Ledger | Updating or deleting a posting is rejected | Database |
| Ledger | Wallet cannot go negative | Database |
| Ledger | Second starter grant for the same user is rejected | Database |
| Identity | Same phone or normalised email cannot create a second account | Database |
| Identity | Gmail dots and plus-tags normalise to one fingerprint | Unit |
| Identity | Under-18 birthdate is refused | Unit |
| Card | Number has the fixed prefix, sixteen digits, and always fails the Luhn check | Property |
| Card | Same inputs give the same number; different sequence gives a different one | Property |
| PIN | Sequential, repeated, common and birthdate-derived PINs are rejected | Unit |
| PIN | Fifth consecutive failure locks; success resets the counter | Unit, then Database |
| Checkout | US-03: same key and payload returns the same order; different payload conflicts | Concurrency |
| Checkout | Two purchases competing for insufficient funds: one succeeds, one declines, no overdraft | Concurrency |
| Checkout | US-30: two buyers for the last unit: one order, one `SOLD_OUT`, no debit | Concurrency |
| Checkout | US-15: freeze racing pay gives one clean outcome | Concurrency |
| Checkout | Price changed between quote and pay returns `CART_CHANGED` with no postings | Database |
| Threshold | US-04: ₹1 crore exactly stays locked; one paise below unlocks once | Unit, then Database |
| Coupon | US-41: redemption cap holds under simultaneous use; owner cannot redeem own | Concurrency |
| Coupon | US-42: platform coupon cannot exceed campaign budget | Concurrency |
| Delivery | Stage is a pure function of timestamps; Delivered exactly at the promised time | Unit |
| Delivery | US-39: Zap offered only when a hub unit is available | Database |
| Privacy | US-46: address readable only by its owner; absent from events and exports | Database, End to end |
| Access | A worker cannot reach orders, finances or coupons by any route | Authorisation |
| Access | Every console route refuses a non-admin account | Authorisation |
| NPC | US-10: adding and deleting NPC data leaves wallets, rankings and metrics unchanged | Database |
| UI | Every form control has a label; every dialog traps and restores focus | Component |
| UI | Price shows compact lakh/crore text with an exact accessible label | Component |
| Journey | Sign up, receive ₹100 crore, buy, track delivery, see it in the collection | End to end |

---

## 4. Review mechanism

Three layers, in order. A change does not reach the next layer until it passes the one before.

| Layer | Who | What it checks | Applies to |
|---|---|---|---|
| 1. Automated gates | Pipeline | Types, lint, boundaries, all tests, scans, bundle budget | Every change |
| 2. Independent agent review | A reviewer agent that did not write the change and is given the diff and the standards, not the author's reasoning | Correctness, invariants in `CLAUDE.md`, missing tests, security and privacy, accessibility | Every change |
| 3. Human review | You, next day, with fresh eyes | Does it do what the requirement says; is anything in the guarded zone weakened | Guarded zone always; fast zone by sampling |

**Why the reviewer is independent.** A reviewer handed the author's explanation tends to confirm it. The reviewer gets the code and the rules only.

**Review checklist (both agent and human)**
1. Which requirement does this satisfy, and is there a test naming it?
2. Could any path change a balance, stock count or entitlement outside the pay transaction?
3. Is every new route in the authorisation tests? Is every new table covered by row-level security and grants?
4. Any personal data in logs, events, errors or fixtures?
5. Any literal that should be configuration? Any float near money?
6. Were any tests removed, skipped or loosened?
7. For UI: keyboard path, focus, labels, both themes, phone width.
8. Is the change as small as it could be?

**Severity**
- Blocker: breaks an invariant, a security or privacy rule, or a test. Must be fixed.
- Major: wrong behaviour or missing test on a stated requirement. Fixed before merge.
- Minor: clarity, naming, small duplication. Fixed or noted.

Periodic deeper reviews: a security review before each cohort, an accessibility review of the critical journeys before the 200-person beta, and a restore-and-reconcile drill.

---

## 5. Skills and agents

### 5.1 Claude Code skills to use

| When | Skill |
|---|---|
| Reviewing a change for bugs | `code-review` |
| Security pass on pending changes | `security-review` |
| Cleaning up after a feature | `simplify` |
| Seeing a change work in the running app | `run` |
| Checking screens for accessibility | `design:accessibility-review` |
| Auditing or extending the design system | `design:design-system` |
| Critiquing a screen | `design:design-critique` |
| Writing interface copy | `design:ux-copy` |
| Planning tests for a module | `engineering:testing-strategy` |
| Before a production deploy | `engineering:deploy-checklist` |
| Debugging a failure | `engineering:debug` |
| Recording a design decision | `engineering:architecture` |

### 5.2 Project agents (`.claude/agents/`)

| Agent | Model tier | Use for |
|---|---|---|
| `guarded-builder` | Highest | Ledger, pay, pricing, inventory, promotions, identity, policy, migrations |
| `fast-builder` | Middle | Components, pages, tables, forms, styling |
| `test-writer` | Middle | Turning acceptance criteria into tests; filling coverage gaps |
| `reviewer` | Highest | Independent review against the checklist; read-only |
| `content-writer` | Lowest | Seed catalogue, interface copy, fixtures, documentation tidy-ups |

### 5.3 Human skills the project needs

TypeScript and React; SQL and PostgreSQL transactions, constraints and row-level security; web security basics (sessions, CSRF, content policy); accessibility testing with a keyboard and a screen reader; reading a diff critically. The last one matters most: with agents writing most of the code, the scarce skill is review.

---

## 6. Multi-agent working and cost control

Recommended practice, based on how these tools behave rather than on a published standard.

**How work is split**
- One agent per work package with a disjoint set of files, so agents can run in parallel without conflicts.
- A shared contract first (types, component props, table definitions), then parallel builds against it.
- Build, then independent review, then fix. The lead session integrates and runs the full checks.

**Choosing the model**

| Work | Tier | Reason |
|---|---|---|
| Guarded-zone logic, migrations, concurrency tests, reviews | Highest | Errors are expensive and subtle |
| Components, pages, ordinary tests | Middle | Well-trodden patterns; checks catch mistakes |
| Seed data, copy, fixtures, mechanical edits | Lowest | High volume, low risk |

**Keeping token use down**
1. Give each agent a narrow brief: goal, files it owns, the contract, the commands to verify, what "done" means. Point to documents by path and section instead of pasting them.
2. Keep `CLAUDE.md` short; it is read on every run.
3. Agents report a summary, not file dumps: what was built, test results, open questions.
4. Do not spawn an agent for a task that is a handful of edits.
5. Prefer many small packages on a cheaper tier over one large package on the top tier.
6. Reuse: one worked example per pattern for agents to copy, instead of re-deriving conventions each time.
7. Let tests, not re-reading, establish correctness: an agent runs the checks instead of reasoning about whether code is right.
8. Stop early: if a package's checks fail twice for the same reason, return to the lead with the error rather than looping.

---

## 7. Definition of done

- Types, lint and all tests pass locally and in the pipeline.
- New behaviour has tests naming its requirement; new routes are in the authorisation tests; new tables have security tests.
- Loading, empty, error and unavailable states exist for new screens.
- Keyboard-usable, labelled, works in both themes and at phone width.
- No personal data in logs or events; private responses uncacheable.
- Independent review done; guarded-zone changes reviewed by a person.
- Documents updated if a rule changed.

---

## 8. Sources

- Brad Frost, *Atomic Design*: https://atomicdesign.bradfrost.com/chapter-2/
- Kent C. Dodds, "Write tests. Not too many. Mostly integration.": https://kentcdodds.com/blog/write-tests
- Kent C. Dodds, "The Testing Trophy and Testing Classifications": https://kentcdodds.com/blog/the-testing-trophy-and-testing-classifications
- web.dev, "Pyramid or Crab? Find a testing strategy that fits": https://web.dev/articles/ta-strategies
- Claude Code documentation, subagents: https://code.claude.com/docs/en/sub-agents.md
- W3C, WCAG 2.2: https://www.w3.org/TR/WCAG22/

Research note: these came from search summaries; the primary pages were not opened. Reports conflict on whether a subagent with no model setting inherits the lead model or defaults to a middle tier, so the project agents set a model explicitly.
