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

## Cannot be decided for you

| Item | Why it needs you |
|---|---|
| Creating the hosting, database, email, bot-check and monitoring accounts | They must be in your name; some need a card or phone |
| Any spending: domain, SMS, paid plans | Your money |
| Privacy notice, terms, and whether notice-only research use is lawful | Needs a qualified reviewer; no real users before this |
| Deploying to the internet and inviting people | Outward-facing and hard to undo |
| Who draws final art, if you want better than generated illustrations | Taste and budget |
