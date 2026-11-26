# Decisions made on the owner's behalf

On 20 November 2026 the owner asked for open decisions to be made for them. Each choice below is the safer or cheaper default and can be reversed; the last column says what reversing it involves. Decisions that need money, a legal opinion or an account in the owner's name are listed separately because they cannot be made by anyone else.

## Decided

| # | Decision | Choice | Why | To reverse |
|---|---|---|---|---|
| 1 | Domain name | None for now. Run on the free hosting address with Google sign-in only. | No spend; email links need a domain | Buy a domain, add the email provider, switch on email-link sign-in |
| 2 | Phone verification | Collect phone with country code; store as an unverified, unique claim until an SMS provider is chosen | SMS costs money and needs sender registration | Connect a provider; the verification step already exists in the design |
| 3 | Countries accepted | India (+91) only | Matches the launch cohort and the notation | Add codes to the server allow-list |
| 4 | Pre-selected checkout destination | Fictional delivery spot; real address is one tap away | Collects less personal data by default | Change one default |
| 5 | Phone number on addresses | Not collected (the account already has one) | No use for it | Add a field |
| 6 | Text-screening classifier | On, behind a switch, when a free endpoint is configured; rules and human review always on | Cuts daily review load for one operator | Turn the switch off |
| 7 | Art for templates and seed products | Generated geometric illustrations tinted per product, built into the app | No cost, no rights questions, ships now | Replace the illustration component with commissioned art |
| 8 | Research opt-out | Kept in privacy settings, not promoted | Lowers legal risk at no cost | Remove the switch |
| 9 | Product and membership names | Keep "DeluluMart" and "Delulu Plus" as working names | Clearance is a later step | Rename through configuration and copy |
| 10 | Database access layer | Plain SQL migrations and the `pg` driver for the foundation; Drizzle schema to be layered on when the app is wired to the database | The constraint-heavy schema is clearer in SQL; avoids two sources of truth early | Generate the Drizzle schema from the database |
| 11 | Card-number prefix | `042000` | Begins with 0, a range no payment network issues in | Change one configuration value before any card is issued |
| 12 | Raw analytics retention on the free database | 30 days, then archive | Keeps the database under its size limit | Raise it on a paid plan |
| 13 | Tonight's build order | Foundation that can be proven without external accounts: design system, domain logic, database schema and tests, storefront pages on seed data | Everything else needs accounts only the owner can create | — |
| 14 | Ratings and reviews (not in the PRD; the owner asked for big-marketplace features and delegated product decisions, 26 November 2026) | Owners of a product review it; details below | The most visible missing marketplace feature; kept small and private by default | Hide the product page section and revoke the review functions; the tables can stay |

### 14. Ratings and reviews

| Rule | Choice |
|---|---|
| Who may review | Only a player who owns the product (an active ownership row, created by the purchase). Never an owner of the selling company. No job, seed or NPC path writes reviews. |
| How many | One review per player and product. Saving again edits it: a new version is kept and the review shows "Edited". The author can delete it; the text and versions are deleted for real. |
| What | Rating 1 to 5 (required); title up to 80 characters, on one line, and review up to 1,000 (optional). `REVIEW_RULES` in `packages/core/src/review` is the one source of these numbers; the database reads the same configuration keys with those defaults, clamped (migration 0079). |
| Text screening | The listing and store text rules (`packages/core/src/screening`). Anything not screened OK is refused with per-field reasons, because there is no human review queue for reviews; brand-like or shouted text is refused too. No submitted text is echoed. Since review round 1 the shared rules also refuse hidden format and separator characters (a joiner inside an Indic word excepted), read digits of every script as digits, and treat any dotted domain-like word as a link. The database (migration 0079) refuses the same as a backstop. |
| Limits | 10 review writes an hour per account (web rate limit, `core.rate_hit`). |
| Public display | Average to one decimal from integer sum and count (sent as `averageTenths`, never a float), count, five distribution bars, newest reviews ten per page. Each shows stars, title, text, the author's public handle if they set one, a "Verified owner" badge and the day (store reporting time zone). Never a user id, order, purchase time or review id. |
| Timing | A review is public only from the reporting day (Asia/Kolkata) after the one it was written in (migration 0079). The author sees it at once, marked "Visible to others from tomorrow"; the average and count include public reviews only. |
| Cards and rails | A separate public endpoint returns summaries for up to 100 product ids; the catalogue response is unchanged. |
| Moderation | The Super Admin hides a review with a reason and can restore it (audited). Hidden reviews leave the list and the average; the author still sees theirs as hidden, with the reason. Deleting and writing again does not undo a hide. |
| Analytics | `review_submitted` and `review_hidden` server events, with no props, user id or text. |
| Why the next day (decided in review round 1) | A review under a public handle says that this player owns the product, which is its purpose. The seller sees each order to the minute with no buyer. Publishing a review the moment it is written (or the minute after the purchase) would let a seller match a handle to an order for a product that sells rarely; publishing only the next day, and showing only the day, decouples the review from the order's time, so a review says no more than "bought on or before that day". |
| Not in this round | Reporting a review (use the console for now), helpfulness votes, photos, seller replies. |

## Cannot be decided for you

| Item | Why it needs you |
|---|---|
| Creating the hosting, database, email, bot-check and monitoring accounts | They must be in your name; some need a card or phone |
| Any spending: domain, SMS, paid plans | Your money |
| Privacy notice, terms, and whether notice-only research use is lawful | Needs a qualified reviewer; no real users before this |
| Deploying to the internet and inviting people | Outward-facing and hard to undo |
| Who draws final art, if you want better than generated illustrations | Taste and budget |
