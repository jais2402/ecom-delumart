# DeluluMart PRD — Revision 1.5

Date: 20 November 2026 · Status: proposed, for owner approval
Applies on top of: DeluluMart PRD v1.4 (19 October 2026). Section numbers (§) refer to v1.4 unless prefixed "R".
Companion: `docs/architecture.md`.

Revision 1.5 completes the product as a full commerce experience across six modules: storefront, account, payment simulator, simulated delivery, a platform back office, and a merchant portal. It also records the earlier decision to ship V1 without AI-assisted creation. Everything v1.4 says about the fictional-money contract, the ledger, source separation and safety remains in force unless listed in R9.

As in v1.4, numeric values, names and limits below are proposed defaults, not validated commitments.

---

## R1. Coverage check: requested modules against v1.4

| # | Requested module | In v1.4? | What v1.4 has | What was missing | Added in |
|---|---|---|---|---|---|
| 1 | E-commerce frontend: landing, category, product page, search, other common pages | **Partly** | Landing/marketplace, search, category and price filters, product detail, store links (§6.3, US-02) | Dedicated category and store pages, cart, multi-step checkout, order confirmation, order tracking, deals, membership and help pages. v1.4 is buy-now only; a cart was P1. | R2 |
| 2 | Account: login, orders, payments, wallet, transactions | **Mostly** | Sign-in, My bank with statement and card controls, collection with purchase history, privacy controls (§6.3, §7.13, US-12) | One account hub; an Orders page with status and tracking; a Payments page listing attempts, methods and refunds; delivery spots; membership | R3 |
| 3 | Dummy payment simulator close to real life | **Partly** | DeluluPay with one virtual card and a single in-app approval (§7.13) | Multiple payment methods, a bank authentication step, realistic statuses and decline reasons, test scenarios. v1.4 explicitly ruled out one-time codes. | R4 |
| 4 | Quick commerce, Prime-style and normal delivery | **No — excluded** | v1.4 states no delivery and no addresses; items go straight to the collection (§1.1) | Everything: delivery speeds, fees, tracking, a membership, quick-commerce eligibility | R5 |
| 5 | Back office to configure products, shipping, payments, coupons (as in Shopify, BigCommerce, Magento) | **Partly** | Staff moderation, reports, appeals, reversals, kill switches, platform analytics (§7.1, §7.7, §7.12) | A configuration back office: catalog and categories, merchandising, promotions, shipping, payment methods, customers, merchants, settings | R7 |
| 6 | Entrepreneurship / merchant portal: products, shipping, pricing, discounts, sales and revenue | **Mostly** | Partner Portal: products, orders, finances, analytics, warehouses, team (§7.15, §7.16) | Shipping configuration, sale pricing, merchant discounts and coupons, delivery view on orders | R6, R8 |

Summary: two modules were mostly present, three partly, and delivery was explicitly out of scope. Coupons and discounts did not exist anywhere in v1.4.

---

## R2. Storefront

### R2.1 Pages

| Page | Purpose and required content |
|---|---|
| Home | Premise, starting-fortune action, fictional-money label, staff-managed banners, shelves (Fresh, Player favorites, Staff picks, Deals), categories. No fabricated activity ticker (§6.3). |
| Category | One page per category with sub-filters: price range, delivery speed available, in stock, on sale, store. Sort: fresh, price, player favorites. Cursor pagination. |
| Search results | As US-02, plus the same filters and "did you mean" for zero results. |
| Product detail | As §6.3, plus: sale price with honest reference price (R6.2), delivery options with estimated arrival, stock/edition state (§7.16), Add to cart and Buy now, store card. |
| Store | Public storefront for one company: identity, published products, delivery speeds offered, active public coupons. |
| Cart | Lines grouped by seller, per-line price, coupon entry, delivery choice per seller group, fee and total summary, fictional-money label. |
| Checkout | Steps: delivery spot → delivery speed → payment method → review → pay (R4). |
| Order confirmation | Order group reference, per-seller orders, estimated arrival, receipt link. |
| Track order | Timeline per shipment (R5.3). |
| Deals | Active sales and public coupons. No countdown pressure (§7.11). |
| Membership | Delulu Plus benefits, price, status (R5.5). |
| Help and policies | How fictional money, delivery simulation, payments and reports work; terms; privacy. |
| Unavailable / not found | As §7.2 J7. |

### R2.2 Cart (moves from P1 to P0)

- Up to 20 lines; quantity is always one per product and one ownership per account (US-09 unchanged). A product already owned cannot be added.
- A cart may hold products from several sellers. Checkout creates one **order group**, with one **seller order** per seller and one shipment per seller order.
- The cart is a convenience list. It reserves no stock and guarantees no price (§7.4: "a quote does not reserve stock").
- Checkout is all-or-nothing: if any line is sold out, hidden, repriced, or blocked at payment, nothing is debited; the cart is updated and the player re-confirms.
- Buy now remains as a one-line checkout through the same flow.
- The signed-out cart lives in the browser and merges into the account cart at sign-in.

---

## R3. Account hub

One area at `/account`, replacing the scattered "My bank" and collection entry points. All of it is private to the owner.

| Section | Content |
|---|---|
| Overview | Balance summary, recent orders, arriving deliveries, collector level, creator/company status |
| Orders | Order groups and seller orders with status, items, amounts, delivery timeline, receipt download |
| Payments | Every payment attempt with method, status, reference and decline reason; refunds from staff reversals |
| Wallet and bank | Balance, bank identity, paginated statement (§7.13), statement download |
| Cards and methods | Delulu Card: view number (masked, reveal on tap), set/change/reset PIN, freeze/unfreeze/replace; DeluluPay ID; default method (R4.7) |
| Addresses | Saved delivery addresses, real or fictional (R5.2) |
| Membership | Delulu Plus status, expiry, renew |
| Collection and saves | As §6.3 and US-09 |
| Privacy and security | Active sessions and sign-out everywhere, privacy flags, data export, account deletion (US-12) |
| Notifications | In-app notification history and preferences |

### R3.1 One account per person: phone and email

To avoid duplicate accounts (and duplicate ₹100 crore grants), every account has exactly one email address and one phone number, and neither can belong to another account.

**Collection**
- Phone number with country code, chosen from a country list and stored in the international standard format (for example +91 followed by the number). Numbers are validated for the selected country.
- Email as today (§7.2 J1).

**Uniqueness**
- One account per phone number and one account per email address, enforced by the database, not only by the sign-up form.
- Emails are compared in a normalised form (case, and provider tricks such as dots and "+tags" in Gmail addresses) so one mailbox cannot open several accounts. The address as typed is kept for sending.
- Signing in with Google and with an email link to the same address reaches the same account (explicit linking, US-01).

**Verification — required for uniqueness to mean anything**
- The phone number is confirmed with a one-time code sent by SMS during onboarding. Without this, anyone could type a made-up number, or type someone else's and block them.
- The starting grant, bank account and card are created only after both email and phone are verified. This strengthens US-01.
- "This number already has an account" is shown only after the code is confirmed, so the form cannot be used to check whether a stranger's number is registered.
- This is the product's only SMS. It is labelled as DeluluMart account verification and is never part of a payment (R4.5 unchanged).
- SMS verification is a small real cost and needs a provider; see R13. Until a provider is live, numbers are stored as unverified claims: unique, but released automatically if someone else later proves ownership of that number.

**Changes and edge cases**
- Changing the phone number requires a fresh sign-in and a code sent to the new number; the old number is then released.
- Mobile numbers get reassigned by carriers. If a new owner verifies a number already on another account, the number moves to them; the earlier account keeps working through its email and is asked for a new number at next sign-in. Nobody can take over an account with a phone number alone: sign-in stays email-based.
- After account deletion the phone and email are erased. A non-reversible fingerprint of each is kept for 12 months for one purpose only: a returning person can open a new account but does not receive a second starting grant. Retention period to be confirmed by the privacy reviewer.

**Privacy**
- Phone number is visible only to its owner. Sellers, workers, other players, share cards, analytics and partner exports never contain it.
- It is used for verification and account recovery only: no marketing messages, no sharing, no contact-list matching.
- Held by the sign-in service, protected by database encryption at rest and access controls (not separately field-encrypted, unlike birthdate and address); staff see it masked, with full view behind an audited permission.

"Wallet" and "bank balance" remain two views of one ledger balance (§1.2). Orders, Payments and Transactions are three views of the same committed records and must reconcile: one seller order ↔ one share of one successful payment ↔ the corresponding statement rows.

---

## R4. DeluluPay payment simulator

### R4.1 Intent

Checkout should feel like paying online in India: choose a method, get sent to the bank, authenticate, see a result with a reference number, find it in payment history. It remains an internal game system backed only by the player's fictional bank balance. No method creates money, grants credit, or connects to any real network (§7.13 unchanged).

### R4.2 Methods

| Method | Experience | Notes |
|---|---|---|
| Delulu Card | Pick the saved card → redirected to a "Delulu Bank SecureCheck" page → enter the card's Delulu PIN | Default. Card number and PIN rules in R4.7. |
| DeluluPay ID | Pick or type a DeluluPay ID such as `handle@delulu` → an approval request appears from the bank → Approve or Decline | Mirrors a collect-request flow. |
| Net banking | Choose Delulu Bank → simulated bank page showing account alias and amount → enter a six-digit code shown in the in-app bank inbox | Further banks appear here when enabled (§7.13 future banks). |
| Bank balance | One-tap pay from balance with a confirmation panel | The v1.4 behaviour, kept as the fastest path. |
| Pay on delivery | Not in this release | Needs holds that count toward owned wealth (§7.13); deferred. |

All four draw on the same bank account. Method availability, ordering and per-method limits are configured in the back office (R7).

### R4.3 Statuses shown to the player

`Created → Authenticating → Authorised → Captured`, or `Failed` with a reason, later possibly `Refunded`.

- "Authenticating" is the bank step. It moves no money and places no hold.
- "Authorised" and "Captured" are displayed stages of the single atomic commit defined in §7.4; they are not separate ledger events and no artificial delay is added (§7.13).
- "Refunded" appears only through a staff reversal (§7.4). There is still no player-initiated cancel, return or refund button; the v1.4 reason stands (it would let players spend to unlock and then undo it).

Decline reasons, each stating that no fictional money moved: insufficient funds, card frozen or replaced, wrong code, code expired, too many attempts, cancelled by you, method unavailable, method limit exceeded, bank temporarily unavailable, session expired.

### R4.4 Authentication step rules

Card payments authenticate with the Delulu PIN (R4.7). Net banking authenticates with a one-time code:

- The code is generated by the server, valid for three minutes, single use, three attempts, with resend allowed after 30 seconds.
- It is delivered only inside the app. No SMS, email or push message carrying a code is ever sent, so the product cannot be mistaken for, or abused as, a real bank message.
- The signed-in session remains the real authority for the payment (§7.13). The code step is validated server-side and is part of the experience, not a second security factor.

### R4.5 Never collect real payment data

This replaces the v1.4 sentence "Do not fabricate OTP messages" with stricter, more specific rules:

- There is no field anywhere that accepts a real card number, expiry date, CVV, UPI PIN, ATM PIN, net-banking password or real bank account number. A Delulu Card number is only ever displayed and selected, never typed in.
- The one secret a player chooses is the Delulu PIN, under the safeguards in R4.7 that exist specifically to stop people reusing a real PIN. One-time codes are always system-generated and displayed.
- Any free-text field in checkout rejects input that looks like a card number or a real UPI handle.
- DeluluPay IDs end in `@delulu`; card and account aliases stay non-numeric (§7.13). No real bank, card-network or payment-app names or logos.
- Every payment page carries "In-game payment · fictional money".

### R4.7 Delulu Card number and PIN

**Birthdate.** To issue a card the player gives their date of birth once, during onboarding. It also replaces the bare 18+ checkbox as the adult-eligibility check (§1.1), though it remains self-declared. It is personal data: stored encrypted, visible only to the owner in the account hub, never public, never in analytics, logs or exports other than the owner's own. A correction goes through support.

**Card number.** Each card has a 16-digit number generated by an algorithm that takes the player's birthdate as an input.

- The birthdate is mixed with the account id and a card sequence through a keyed one-way function held on the server. The number is therefore unique to the player and stable for that card, but the birthdate **cannot be read or worked out from it**, and nobody can predict another player's number from knowing their birthday. Putting birthdate digits directly into the number is not allowed: anyone who saw the card, including in a screenshot, would learn the owner's date of birth, and numbers would become guessable.
- The number can never be mistaken for, or collide with, a real payment card: it starts with a fixed prefix in a range no card network uses, and its last digit is chosen so that it always fails the standard card checksum. Any real payment form will reject it.
- It is an identifier, not a credential. Knowing a card number lets nobody pay; payment still requires the owner's signed-in session and PIN.
- Shown masked (last four digits) by default; the owner can reveal the full number in the account hub. Replacing a card issues a new number. There is no expiry date or CVV.

**Delulu PIN.**

- Six digits. Six rather than four on purpose: real card PINs in India are four digits, so a six-digit PIN cannot simply be a reused one.
- Set by the owner in Account → Cards and methods before the first card payment. The screen states: "Game PIN only. Do not use the PIN of a real card or UPI app."
- Rejected at set time: repeated or sequential digits, common PINs, and any arrangement of the player's own birthdate.
- Required for every Delulu Card payment. Three wrong attempts fail that payment with no debit; five wrong attempts in a row lock card payments for 15 minutes. Other payment methods keep working, and the lock clears early if the owner resets the PIN.
- Change requires the current PIN. A forgotten PIN is reset after the owner signs in again (fresh email link or Google sign-in); support staff can neither see nor set a PIN.
- Stored only as a protected hash that cannot be reversed even with a copy of the database; never displayed, logged, emailed or included in any export.
- Freezing a card blocks payment regardless of PIN. Replacing a card keeps the PIN unless the owner changes it.

### R4.6 Test scenarios

Staff and staging accounts can force outcomes (decline, bank unavailable, slow bank, wrong-code lockout) through reserved test DeluluPay IDs and a scenario setting, in the way payment gateways provide test instruments. Scenarios are never applied randomly to players. A method can be put into scheduled "bank maintenance" from the back office; players see an honest unavailable state.

---

## R5. Simulated delivery

### R5.1 Contract

Nothing physical exists and nothing real is shipped. Delivery is a simulation that gives an order a journey. v1.4's sentence "no physical delivery … or shipping addresses" (§1.1) is amended to: **no physical delivery; delivery is simulated. Players may save a real address or choose a fictional delivery spot.** Microcopy changes from "Nothing ships" to "Nothing real ships — delivery is simulated."

Ownership, creator-threshold evaluation, seller proceeds, brand-qualifying revenue and collector counts are all still settled at payment commit (§7.4). Delivery changes presentation only: an item shows as "Arriving" until delivered, then appears on the shelf with its receipt reveal.

### R5.2 Delivery addresses

Players may add a real address so checkout feels like real shopping. Because nothing is ever delivered, the address has no operational use; it is personal data held only for the player's own experience, and it is protected accordingly. This amends the v1.4 position of collecting no address or location data (§7.7) and must be covered by the privacy review before the first invite.

**What a player can save**
- Up to five addresses. Fields: label (Home, Work, Other), recipient name, address line 1, address line 2 (optional), city, state, pincode.
- No separate phone number on an address (the account's own number is in R3.1), no map pin, no device location, and no lookup against any outside address or geocoding service. Pincode is checked for format only.
- A **fictional delivery spot** remains available as an equal alternative, chosen from lists (for example "Cloud Nine Heights"), so nobody has to give a real address to shop. Whether the address form or the fictional spot is the pre-selected option is a decision for the product and privacy owners (R13).

**Notice at the point of entry**
"Nothing will be delivered to this address. It is used only to make checkout and tracking feel real, and only you can see it. You can use a fictional spot instead."

**Who can see an address**
- The owner only: in the address book, at checkout, and on their own orders and tracking.
- Never the seller, a worker, another player, a share card, a receipt download shared publicly, analytics, logs, or any partner export. Sellers see no location for an order at all in this release, consistent with anonymous purchase attribution (§7.2 J5).
- Support staff can open an address only through a specific permission, with a recorded reason, and each view is audit-logged.

**Handling**
- Stored encrypted at field level, in addition to database encryption; readable by the owner's requests only.
- A player can edit or delete an address at any time. Deleting it removes it from past orders too: orders keep only "Address removed".
- On account deletion all addresses are erased immediately, not pseudonymised, and are covered by the deletion tombstone so a backup restore cannot bring them back (§7.7).
- Included in the owner's own data export (US-12); excluded from every other export.
- Delivery promises, fees and Zap eligibility do not depend on the address in this release, so no feature needs to read it.

### R5.3 Speeds

| Speed | Proposed promise | Proposed fee | Eligibility |
|---|---|---|---|
| Standard | Arrives in 24 hours | ₹1,000 | Every product |
| Express | Arrives in 2 hours | ₹10,000; free with Delulu Plus | Products whose seller offers it |
| Zap (quick commerce) | Arrives in 10 minutes | ₹50,000; ₹25,000 with Delulu Plus | Only items with an available unit in the seller's Zap hub (R5.4) |

- Fees are charged per seller order, are shown before payment, and go to SINK. They are a currency sink, not seller revenue or GMV.
- Timeline: `Placed → Packed → Shipped → Out for delivery → Delivered`. Stage times are fixed when the order commits and shown in the player's local time.
- Delivery is deterministic and always succeeds in this release: no random failures, no "pay to speed up" after ordering, no countdown pressure (§7.11). A delivered notification links to the collection.
- A staff reversal of an undelivered order ends its timeline as "Cancelled by support".
- NPC simulations create no shipments.

### R5.4 Quick commerce

Real quick commerce delivers a small assortment from nearby dark stores in minutes. The game equivalent reuses company warehouses (§7.16):

- A company may mark one of its warehouses as its **Zap hub**. Only stock allocated there is Zap-eligible; the product page shows "Zap in 10 minutes" only while a unit is available in the hub.
- Hub stock uses normal warehouse capacity, so offering Zap is a real trade-off for the merchant.
- Platform seed items are Zap-eligible when staff flag them.
- A seller order ships at one speed; if any line in it is not Zap-eligible, Zap is not offered for that seller order.

### R5.5 Delulu Plus membership

The user requirement was "Prime shipping". "Prime" is another company's brand, and v1.4 requires original branding (§6.2, §7.15), so the working name is **Delulu Plus** (provisional, not availability-cleared).

- Benefits: free Standard and Express delivery, half-price Zap, a profile badge. No purchasing advantages, no early access to exclusive stock, no currency rewards.
- Proposed price: ₹2 lakh of fictional money for 30 days, paid through DeluluPay as a new checkout type. The full amount goes to SINK.
- No auto-renewal in this release; the player renews manually and is told before expiry in-app.
- Buying or holding a membership never triggers the creator unlock by itself, and is not a product order, GMV, or a collector item — the same treatment as the company fee (§7.14).
- Membership is never sold for real money (§8.4 "Monetization: none").

---

## R6. Pricing, discounts and coupons

### R6.1 Principles

Discounts must stay honest and must not become a hidden money faucet. One code per checkout in this release; no stacking.

### R6.2 Sale price (merchant)

A merchant may set a lower price and show the previous price as a struck-through reference. The reference price must have been the product's actual published price for at least 24 continuous hours; otherwise only the current price is shown. A price change still invalidates outstanding quotes and follows version rules (US-08).

### R6.3 Merchant coupons (seller-funded)

- Created by the company owner in the Partner Portal. Applies only to that company's products.
- Type: percentage (1–90%) or flat amount. Options: minimum spend, validity window, total redemption cap, one redemption per buyer, public (listed on the store page) or private (code only).
- Up to five active coupons per company. Codes are 4–16 letters/digits and pass the same text screening as listings.
- The buyer pays the reduced amount; the seller simply receives less. No currency is created.
- The discounted line price may not go below the ₹100 minimum (§7.4).
- Owners, current workers and excluded former workers cannot redeem their own company's coupon (same relationship rules as buying, §7.14).

### R6.4 Platform coupons (platform-funded)

- Created only by staff in the back office, with a campaign budget cap and two-person approval.
- The discount is paid from MINT into the same transaction, so the seller still receives proceeds on the full price. This **is** a faucet and is treated as one: it is ledgered, capped, reported in the mint/sink dashboard, and added to the reconciliation identity (§7.4).
- Never issued as a referral, sharing or popularity reward (§7.5).

### R6.5 Free delivery offered by a merchant

A merchant may offer free Standard delivery on their products. The fee is then deducted from the seller's proceeds and still goes to SINK.

### R6.6 Accounting

Fee rule (amends §7.4): the 5% marketplace fee is calculated on the **list price after any seller-funded discount** — that is, on what the seller is selling it for — and is unaffected by platform coupons or delivery fees.

| Event | Signed postings | Circulating effect |
|---|---|---|
| ₹2 crore item, 10% merchant coupon, Standard delivery | Buyer −₹1,80,01,000; seller +₹1,71,00,000; SINK +₹9,01,000 (₹9,00,000 fee + ₹1,000 delivery) | −₹9,01,000 |
| ₹2 crore item, ₹10 lakh platform coupon, free delivery (Plus) | Buyer −₹1,90,00,000; MINT −₹10,00,000; seller +₹1,90,00,000; SINK +₹10,00,000 | No net change (mint ₹10 lakh, sink ₹10 lakh) |
| Delulu Plus, 30 days | Buyer −₹2 lakh; SINK +₹2 lakh | −₹2 lakh |
| Merchant-funded free Standard delivery on a ₹1 lakh item | Buyer −₹1,00,000; seller +₹94,000; SINK +₹6,000 | −₹6,000 |

Progression rules:
- **Brand-qualifying revenue** (§7.14) counts the amount the buyer actually paid for the item: after seller discounts, excluding platform-funded amounts and delivery fees. This prevents platform coupons from manufacturing a brand unlock.
- **Creator threshold** (US-04) is still the wallet balance after a completed product purchase, whatever mix of item price, discount and delivery fee produced it.
- **Player gross sales** in the portal is the discounted list price; discounts given and delivery fees appear as separate columns.

Abuse controls: invalid, expired and exhausted codes return one uniform error; code attempts are limited to 10 per hour per account; redemptions by linked accounts are excluded from progression under the existing review process (§7.5).

---

## R7. Commerce Console (platform back office)

A staff-only back office for running the mart, organised the way established commerce platforms organise theirs (orders, catalog, customers, promotions, shipping, payments, content, analytics, settings). It extends the v1.4 staff surface and replaces "staff-only admin controls" in §7.1. Original layout and naming; not a copy of any platform's interface.

| Area | Capabilities in this release |
|---|---|
| Home | Today's orders, payments success rate, moderation queue, economy mint/sink, alerts |
| Orders | Search all order groups and seller orders; view payment, delivery timeline, ledger links; issue reversals (existing rules, §7.4) |
| Catalog | Seed products (DeluluMart Originals): create, edit, price, publish, Zap flag; categories and sub-filters; template illustration library |
| Merchandising | Home banners, shelves, staff picks, deals page, announcement bar |
| Customers | Account lookup, status, entitlements, collector level, linked-account review, suspension as separate permissions (§7.7) |
| Merchants | Companies, tiers, brand progress, warehouses, coupons in use, suspension |
| Promotions | Platform coupons and campaigns with budgets; oversight of merchant coupons |
| Shipping | Delivery speeds, promises, fees, delivery-spot lists, membership price and benefits |
| Payments | Methods on/off and order, per-method limits, maintenance windows, test scenarios, payment-attempt explorer |
| Moderation | Queue, cases, appeals (§7.7) |
| Economy | Versioned configuration: fees, price bounds, thresholds, relief, quotas, level tables |
| Analytics | Player funnel, creator liquidity, mint/sink, delivery mix, coupon usage, payment-method mix |
| Settings | Staff roles, kill switches, feature flags, audit log, policy pages |

### R7.1 Usage by place

The Console's Analytics area shows where DeluluMart is being used.

- **Views:** a table and map by country, state/region and city, for a chosen period: visitors, sign-ups, active accounts, completed player orders, fictional sales value, payment-method mix, delivery-speed mix, and visitor-to-buyer conversion. Trend per place and top places by growth.
- **How place is known:** the approximate location of the network connection (country, region, city), read by the hosting edge at the moment of each request. It is an estimate: it is wrong for VPN users and often resolves to a nearby larger city.
- **What is not used:** device GPS or browser location permission, the saved delivery address, and the phone number. The country code of the phone is reported separately as "registered country" and never combined into a finer location.
- **Privacy rules:**
  - The connection address itself is not stored for analytics; only the resulting country, region and city labels are.
  - Reports are aggregates. No screen shows where a particular player is or has been, and place is not shown on any account, order or seller view.
  - Any place with fewer than 10 distinct accounts in the period is folded into "Other" at that level, so a small town cannot single someone out.
  - Place labels follow the same 90-day raw-event retention as other analytics (§7.7); daily aggregates are kept.
  - The privacy notice states that approximate location is derived from the connection for usage statistics.
- **Audience:** staff with the analytics permission only. Merchants do not see buyer locations in this release; a region breakdown for merchants, under the same minimum-count rule, is a later option.
- **Honesty:** show "Unknown" for requests with no resolvable place and state coverage, rather than distributing them across known places (same principle as §7.15 missing data).

Rules:
- Every change is attributed, reasoned and audit-logged. Economy-affecting settings (fees, delivery fees, membership price, platform coupon budgets, thresholds) create a new configuration version, apply only to future orders, and are announced in-app (§7.5). Orders keep the version they were placed under.
- Anything that can mint currency needs a second staff approver.
- Staff roles are separated: catalog, merchandising, promotions, operations, economy, moderation, support, administrator. No role can edit a balance.
- No tax, invoicing, multi-currency, multi-storefront, real carriers or real payment providers. These exist in the reference platforms and are deliberately excluded.

---

## R8. Partner Portal additions (merchant side)

Added to the navigation in §7.15:

| Area | Owner | Worker |
|---|---|---|
| Pricing | Set price; set sale price with reference price (R6.2); price history | Propose a price on an assigned draft; cannot change a live price (unchanged) |
| Discounts | Create, pause and end merchant coupons; see redemptions and discount given | No access |
| Shipping | Choose speeds offered per product; mark a Zap hub; allocate stock to it; offer free Standard delivery | See whether an assigned draft's stock plan supports Zap |
| Orders | Adds delivery speed, timeline and delivery fee (not revenue) to each seller order | No access (unchanged) |
| Finances | Adds discount-given and merchant-funded-delivery columns; gross, discount, fee, net shown once each | No access (unchanged) |
| Analytics | Adds coupon performance and delivery-speed mix | No access (unchanged) |

Fulfilment is automatic in this release: merchants watch the timeline but do not perform pack or ship steps. All v1.4 permission rules apply unchanged; a worker can never create a coupon, change shipping or spend.

---

## R9. Clauses of v1.4 amended or superseded

| v1.4 | Change |
|---|---|
| §1, §7.1, §7.2 J4, US-07, §7.8 "AI behavior and operational budget" | **AI-assisted creation is removed from this release.** Creators write listing text and choose a template illustration. Generation jobs, AI quotas, the real-spend budget, `BUDGET_PAUSED` and the "₹50 per first approved listing" goal (§4.1) do not apply. Text screening and human review remain. |
| §1.1 "no physical delivery … or shipping addresses"; §7.7 "no location data" | Simulated delivery (R5). Still no physical delivery. Players may optionally save a real address, visible only to them and protected as personal data (R5.2); no phone, map or device location. |
| §6.4 "Fictional money only. Nothing ships." | "Fictional money only. Nothing real ships — delivery is simulated." |
| §7.1 Shopping: buy-now; multi-item cart P1 | Cart is P0 (R2.2). Gifting, auctions and resale stay out. |
| §7.2 J1 "Receipt and collection update" immediately | Ownership is immediate; the item shows as "Arriving" until its simulated delivery completes (R5.1). |
| §7.4 fee formula | Fee is on the list price after seller-funded discounts (R6.6). Delivery fees and membership are new SINK events; platform coupons are a new MINT event. Reconciliation identity gains these terms. |
| §7.5 limits | 100 completed purchases/day counts cart lines. Adds coupon-attempt and authentication-attempt limits. |
| §7.13 "no SMS, email OTP or additional PIN"; "Do not fabricate OTP messages"; "deliberately nonnumeric alias … no real card-number" | Cards get a 16-digit game number derived with the player's birthdate and a six-digit Delulu PIN (R4.7); net banking gets an in-app code step (R4.4). The number is built so it cannot be a valid real card. The prohibition on real-world messages and real credentials is kept (R4.5). |
| §7.2 J1, US-01, §7.5 "one account per human is not fully provable" | A verified phone number with country code is required in addition to email; one account per phone and per email (R3.1). This is a much stronger duplicate barrier, though still not proof of one human. |
| §7.7 "no location data"; §7.10 "never log … full IP" | Approximate, connection-derived country/region/city is recorded on analytics events for aggregate usage-by-place reports (R7.1). Still no precise or device location, and the connection address is still not stored in analytics. |
| §3.1, §7.10 (`experiment_id` in the event envelope), §7.7 retention | The product is explicitly also a research and experimentation platform: notice-based disclosure, experiment rules, a de-identified research dataset with longer retention, and Console tooling (R15). |
| §1.1, §7.9 User `age_attested_at` | Date of birth is collected once at onboarding for card issuance and the adult check (R4.7). |
| §7.13 checkout types | Adds `MEMBERSHIP_PURCHASE`. `PRODUCT_PURCHASE` now covers an order group of one or more seller orders. |
| §7.14 qualifying revenue | Defined on buyer-paid item amounts (R6.6). |
| §7.15 navigation | Adds Pricing, Discounts and Shipping (R8). |
| §8.1 roadmap | Re-estimated (R12). |

Unchanged and still binding: fictional, non-redeemable currency; one starting grant; both unlock routes; one ownership per product; no trades, gifts, loans, resale or wallet-to-wallet transfers; no voluntary refunds; NPC separation; privacy defaults; accessibility targets.

---

## R10. Data, API and events (delta to §7.8–§7.10)

**New entities**

| Entity | Essential fields / constraints |
|---|---|
| Cart / CartLine | owner; unique (cart, product); max 20 lines; no price or stock authority |
| OrderGroup | buyer, checkout session, payment attempt, totals snapshot; one per successful product checkout |
| SellerOrder (the v1.4 PlayerOrder) | adds order_group_id, list amount, seller discount, platform discount, delivery fee, coupon snapshot |
| Shipment / ShipmentEvent | one per seller order; speed, fee, delivery-spot snapshot, fixed stage timestamps; append-only events |
| Address | owner; kind REAL or FICTIONAL; REAL: label, recipient name, lines, city, state, pincode, all encrypted; FICTIONAL: locality and landmark codes; max five per owner; owner-only access; hard delete |
| PaymentMethodConfig | method, enabled, order, limits, maintenance window; versioned |
| PaymentChallenge | attempt, type PIN or CODE, code hash (CODE), expiry, attempts used; single use |
| VirtualCard (amended) | adds card_number unique (fixed prefix, checksum-invalid), sequence, pin_hash, pin_set_at, failed_pin_count, pin_locked_until |
| User (amended) | adds birthdate, encrypted, owner-only; phone in international format (held by the sign-in service), with unique lookup fingerprint and phone_verified_at; normalised-email fingerprint unique |
| IdentityTombstone | fingerprints of deleted accounts' phone and email, expiry; used only to withhold a repeat starting grant |
| Coupon / CouponRedemption | scope MERCHANT or PLATFORM, owner company or campaign, rule, limits; unique (coupon, buyer); redemption linked to seller order and journal |
| PromoCampaign | budget, spent, approvals; spent ≤ budget enforced transactionally |
| Membership | user, period start/end, purchase journal; one active per user |
| PriceHistory | product, price, effective period; source for reference-price rule |
| ConsoleConfigChange | area, before/after, config version, actor, approver, reason |

**New commands (outline)**

`GET/PUT /cart`, `POST /cart/lines`, `DELETE /cart/lines/:id`, `POST /cart/coupon`; `GET/POST/PATCH/DELETE /account/addresses`; `GET /delivery-options` (for a cart); `POST /checkout-sessions` now accepts a cart, delivery choices, coupon and method; `POST /checkout-sessions/:id/challenge` and `/challenge/verify`; `GET /orders/:id/tracking`; `POST /memberships`; `POST /companies/:id/coupons` and `PATCH …/:id`; `PUT /products/:id/shipping`; `PUT /products/:id/sale-price`; `PUT /warehouses/:id/zap-hub`; staff: `/console/…` for catalog, merchandising, promotions, shipping, payments, economy configuration.

New stable error codes: `CART_CHANGED`, `COUPON_INVALID`, `COUPON_NOT_APPLICABLE`, `DELIVERY_UNAVAILABLE`, `METHOD_UNAVAILABLE`, `METHOD_LIMIT_EXCEEDED`, `CHALLENGE_FAILED`, `CHALLENGE_EXPIRED`, `CHALLENGE_LOCKED`, `PIN_NOT_SET`, `PIN_INCORRECT`, `PIN_LOCKED`, `PIN_WEAK`, `UNDERAGE`, `PHONE_REQUIRED`, `PHONE_INVALID`, `PHONE_IN_USE`, `PHONE_CODE_FAILED`, `MEMBERSHIP_ACTIVE`, `REFERENCE_PRICE_INELIGIBLE`.

**New events:** `cart_updated`, `coupon_applied / coupon_rejected / coupon_redeemed`, `payment_method_selected`, `payment_challenge_issued / passed / failed`, `shipment_created / shipment_stage_changed / shipment_delivered`, `membership_purchased / membership_expired`, `sale_price_set`, `console_config_changed`. Purchase events gain discount, delivery-fee and speed fields. Every event envelope gains `geo_country`, `geo_region`, `geo_city` (approximate, nullable). Delivery fees and membership are reported as sinks, never as sales.

---

## R11. Acceptance criteria

- **US-33 · Cart checkout:** a cart with three products from two sellers produces one order group, two seller orders, one payment and one balanced journal. If one line sells out before payment, nothing is debited and the cart shows the change. Repeating the request returns the same order group.
- **US-34 · Account truth:** every seller order in Orders maps to one successful payment in Payments and to statement rows whose sum equals the amount paid. A failed attempt appears in Payments with a reason and nowhere in the statement.
- **US-35 · Payment methods:** each enabled method completes a purchase with the same ledger result. A disabled method cannot be used by calling the API directly. Exceeding a method limit declines with no debit.
- **US-49 · One account per phone and email:** a second account cannot be created with an already-verified phone number, or with an email that differs only by case, dots or a "+tag" from an existing Gmail address. Two simultaneous sign-ups with the same number produce one account. No grant, bank account or card exists until both email and phone are verified. "Already in use" is revealed only after the code is confirmed. Deleting an account and signing up again with the same phone or email within the retention period gives a working account and no second starting grant. The phone number appears in no seller view, analytics event, log or partner export.
- **US-50 · Usage by place:** the Console shows sign-ups, active accounts and orders by country, region and city for a period, and the totals across places (including "Other" and "Unknown") equal the overall totals for the same filters. A city with nine accounts is not listed by name. No analytics table or log holds a connection address. No screen or API returns a location for an individual account. A user without the analytics permission cannot open the report.
- **US-47 · Card number:** a new card has a unique 16-digit number with the fixed prefix that fails the standard card checksum. The same player and card always show the same number; a replacement card shows a different one. Given only a card number, the birthdate cannot be derived; given only a birthdate, the number cannot be predicted. The number alone cannot authorise a payment.
- **US-48 · Delulu PIN:** a card payment without a PIN set returns `PIN_NOT_SET` and a link to set one. `123456`, `111111` and the player's birthdate digits are rejected. A correct PIN pays once; three wrong PINs fail the payment with no debit; five lock card payments for 15 minutes while other methods still work. Changing needs the current PIN; reset needs a fresh sign-in. The PIN appears in no log, event, export or staff screen.
- **US-36 · Authentication step (net banking):** a correct code proceeds to payment; three wrong codes fail the attempt with no debit; an expired code cannot be used; a code cannot be reused or used on another attempt. No code is ever sent outside the app.
- **US-37 · No real payment data:** no page contains a field for typing a card number, expiry, CVV or password; the only PIN field is the labelled six-digit Delulu PIN. Pasting a 16-digit number or a real-format UPI handle into any checkout field is rejected.
- **US-46 · Address privacy:** a saved real address is returned only to its owner. A seller, worker or another player cannot obtain it through any order, tracking, export or API route. It appears in no analytics event or log line. Deleting it removes it from past orders; account deletion erases it. A staff view without the permission is refused, and a permitted view is audit-logged. Checkout completes equally with a fictional spot.
- **US-38 · Delivery timeline:** a Standard order shows five stages with times fixed at purchase, reaches Delivered at the promised time without further user action, and then appears on the shelf. Ownership, seller proceeds and unlock evaluation are already recorded at payment.
- **US-39 · Zap eligibility:** Zap is offered only while a unit is available in the seller's Zap hub; two buyers racing for the last hub unit produce one Zap order and one `SOLD_OUT` or downgrade prompt with no debit.
- **US-40 · Delivery fees and membership:** a ₹1,000 Standard fee is posted to SINK and appears in no sales, GMV or brand-revenue figure. A Plus member pays no Standard or Express fee and half the Zap fee. Buying Plus from ₹1.01 crore leaving ₹0.99 crore does not unlock creator access.
- **US-41 · Merchant coupon:** a 10% coupon on a ₹2 crore item debits the buyer ₹1.8 crore plus delivery, credits the seller ₹1.71 crore and SINK ₹9 lakh plus delivery. The owner and current workers cannot redeem it. The redemption cap holds under simultaneous use.
- **US-42 · Platform coupon:** a ₹10 lakh platform coupon posts MINT −₹10 lakh inside the purchase journal, cannot exceed its campaign budget under concurrency, requires two staff approvals to create, and adds nothing to brand-qualifying revenue.
- **US-43 · Honest sale price:** a reference price is displayed only if it was the published price for 24 continuous hours.
- **US-44 · Console control:** changing a delivery fee creates a new configuration version, affects only later orders, is audit-logged with actor and reason, and is refused for a staff role without that permission. No console screen can alter a balance.
- **US-45 · Portal additions:** a worker cannot create a coupon, change shipping or see discount finances by any route. Portal gross, discount, fee and net for a discounted order agree with the ledger.

Existing criteria US-01 to US-32 still apply, with US-07 withdrawn (AI drafting) and US-03/US-16 read as applying to an order group.

---

## R12. Roadmap impact

v1.4 estimated 16–18 weeks for two full-time engineers. Revision 1.5 adds a cart, four payment methods with an authentication step, delivery simulation with a membership, coupons with two funding models, a full back office and three portal areas, and removes AI generation. Net effect at the same staffing is roughly eight to ten additional weeks. A solo builder should plan by exit gates, not dates.

Proposed order, each phase shippable to testers:

| Phase | Scope | Exit gate |
|---|---|---|
| 1. Foundation | Identity, ledger, bank, single-method checkout, seed catalog, storefront browse pages, account hub (orders, payments, wallet) | v1.4 foundation gates; US-34 |
| 2. Full shopping | Cart, order groups, all payment methods and authentication step, Standard delivery and tracking | US-33, US-35 to US-38 |
| 3. Creation | Both unlock routes, company registration, manual studio with templates, moderation | v1.4 creation gates |
| 4. Merchant commerce | Partner Portal with pricing, shipping, merchant coupons; Express and Zap; Delulu Plus | US-39 to US-41, US-43, US-45 |
| 5. Commerce Console | Catalog, merchandising, promotions, shipping, payments, economy configuration | US-42, US-44 |
| 6. Brand, warehouses, collector | As v1.4 weeks 13–16 | v1.4 gates |

The console's moderation queue and kill switches are needed from phase 1; the rest of the console can be direct database configuration until phase 5.

---

## R13. Decision register additions

| Decision | Default in v1.5 | Status / owner |
|---|---|---|
| AI-assisted creation | Not in this release | User requirement; product |
| Cart | Multi-seller, 20 lines, all-or-nothing checkout | User requirement; details proposed |
| Payment methods | Card, DeluluPay ID, net banking, bank balance; in-app code step | User requirement; details proposed; engineering/design |
| Real-credential rule | No field accepts real payment data; card numbers are displayed, never typed | Proposed; security/legal |
| Card number | 16 digits from a keyed one-way function of birthdate, account and card sequence; unused prefix; always checksum-invalid | User requirement (birthdate-based algorithm); construction proposed; engineering/security |
| Card PIN | Six digits, owner-chosen, managed in the account hub, with reuse and weak-PIN safeguards | User requirement; length and safeguards proposed; security |
| Date of birth | Collected once, encrypted, owner-only; doubles as the adult check | Follows from the card requirement; privacy/legal |
| Research purpose | Covered by the privacy notice and terms accepted at sign-up; no separate consent prompt; opt-out available in privacy settings | User requirement (research use, no separate consent step); legal basis to be confirmed; privacy/legal |
| Experiment limits | Allowed and never-allowed lists in R15.3 | Proposed; product/safety |
| Research dataset | De-identified, separate role, retained beyond 90 days | Proposed; privacy/analytics |
| Super Admin | Owner role above Console roles; command-centre dashboards; staff, security, data and cost controls | User requirement; scope proposed; product/engineering |
| Analytics engine | Metric catalogue, pre-computed aggregates, single query interface, alerts | User requirement; design proposed; analytics/engineering |
| Single-owner safeguard | 24-hour delayed, cancellable execution in place of a second approver | Proposed; security |
| Usage-by-place analytics | Approximate connection-derived country/region/city; aggregates only; minimum 10 accounts per named place; staff only | User requirement; method and privacy rules proposed; analytics/privacy |
| Phone number | Required, with country code, verified by SMS code; one account per phone and per email | User requirement; verification and reassignment rules proposed; engineering/privacy |
| SMS provider | Needed for phone verification; small real cost per sign-up and, for Indian numbers, sender registration | Open; engineering. Until chosen, numbers are unverified claims |
| Countries accepted | India (+91) at launch, others switchable | Proposed; product/legal (ties to launch jurisdictions, §8.4) |
| Repeat-grant prevention after deletion | Keep phone/email fingerprints 12 months | Proposed; privacy/legal |
| Delivery | Simulated; Standard 24 h, Express 2 h, Zap 10 min; fees to SINK | User requirement; times and fees proposed; product/economy |
| Delivery addresses | Real address allowed, owner-only, encrypted, deletable; fictional spot offered as an alternative; no phone or location | User requirement (real address); protections and default option proposed; privacy/legal |
| Membership name and price | "Delulu Plus", ₹2 lakh / 30 days, manual renewal | Name provisional (the requested "Prime" is another company's brand); product/legal |
| Cancellations and returns | None; staff reversal only | Carried from v1.4; product |
| Coupons | One code per checkout; merchant coupons seller-funded; platform coupons MINT-funded with budget | User requirement; rules proposed; economy |
| Back office | Commerce Console, role-separated | User requirement; scope proposed; product/engineering |

---

## R15. Research and experimentation

### R15.1 Purpose

Behind the player-facing game, DeluluMart serves as a research and experimentation platform: a realistic but consequence-free commerce environment in which to study how people shop, pay, choose delivery, respond to pricing and promotions, and run stores, and in which to trial product and engineering ideas. This section assumes that meaning of "research and experiment purpose". If the intent is narrower (an engineering sandbox only, with no study of player behaviour), R15.3 to R15.6 still describe the experiment tooling and R15.2 can be reduced accordingly.

### R15.2 Transparency

Players are not asked a separate question about taking part in research. Research and experimentation are covered by the privacy notice and terms that every player accepts when creating an account, in the same way most online products cover analytics and A/B testing.

- There is no research consent screen, checkbox or pop-up at sign-up or anywhere in the journey.
- The privacy notice and terms state, in plain words, that activity is analysed and used for research and product experiments in de-identified form, and that different players may see different versions of features. This keeps the project honest without interrupting play.
- An opt-out switch sits in Account → Privacy for players who look for one. It is not promoted. An opted-out account is left out of research datasets built afterwards and out of non-essential experiments, and plays normally.
- Adults only, as already required (§1.1).
- Publishing or sharing findings outside the team uses aggregates or de-identified data only, never anything that could identify a player.
- **Open legal point.** Whether notice-and-terms is a sufficient basis for research use of personal data in the launch jurisdiction, and whether any statutory research exemption applies, must be confirmed by the privacy reviewer before the first invite (§2). If the answer is no, the fallback is a single line and tick box on the existing sign-up form, not a separate step.

### R15.3 What may be experimented on

| Allowed | Conditions |
|---|---|
| Page layout, navigation, copy, search and ranking presentation, onboarding order | Standard A/B assignment |
| Checkout flow, payment-method order and presentation, delivery option presentation | Outcome integrity unchanged: same ledger result for the same purchase |
| Delivery promises and fees, membership price and benefits, coupon mechanics | Variant is a versioned configuration; shown before payment; order keeps the variant it was placed under |
| Economy parameters (fee rate, thresholds, relief) | New-cohort assignment only, never changed for an account mid-way; disclosed in the rules page as "rules may differ between cohorts" |
| Back-office and portal tooling | Staff or merchant opt-in |
| Engineering experiments (caching, query strategies, infrastructure) | No change to observable outcomes; kill switch |

| Never, even as an experiment |
|---|
| Deceiving players about fictional money, simulated delivery, or NPC versus player activity (§1.1, §7.6) |
| Fabricated scarcity, countdown pressure, shaming, random rewards, or other manipulative patterns excluded in §7.11 |
| Randomly failing or delaying a player's payment or delivery to observe the reaction (test scenarios stay staff-only, R4.6) |
| Weakening any security, privacy, moderation or accessibility control for a variant |
| Different ledger integrity rules between variants |
| Anything involving real money |

### R15.4 Experiment framework

- An experiment has an owner, hypothesis, variants, audience, primary metric, guardrail metrics (checkout success, ledger reconciliation, reports, opt-outs), start/stop dates and a status.
- Assignment is per account (or per visitor before sign-in), stable for the experiment's life, and recorded when the player is first exposed.
- Staff, test accounts, fraud-excluded accounts and research opt-outs are excluded from analysis by default.
- A guardrail breach stops the experiment automatically and returns everyone to the control.
- At most a small number of concurrent experiments touching the same surface, with conflicts declared.
- Results show sample sizes, uncertainty and exclusions, and never claim a win from an underpowered test (same honesty standard as §4.1 and §7.15).
- Every experiment, its changes and its outcome are kept as a permanent record.

### R15.5 Research data

- Researchers work from a **de-identified research dataset**, never from production tables.
- Removed entirely: name, email, phone number, date of birth, delivery address, card number, handles, free-text content, connection address, internal ids.
- Transformed: account id → a research-only random id that cannot be linked back without a key researchers do not hold; date of birth → age band; place → country and region only, with the minimum-count rule of R7.1; timestamps kept; amounts kept (they are fictional).
- Included: events, orders, payments attempts and outcomes, delivery choices, coupon use, experiment assignments, store and listing statistics, NPC activity clearly labelled and in separate tables (§7.6).
- Exports are created by an audited job, stored privately, and access-controlled by a research role distinct from support and administration.
- The de-identified dataset may be retained beyond the 90-day raw analytics window for longitudinal study; the period is stated in the notice and confirmed by the privacy reviewer. Account deletion removes the person's rows from future dataset builds.

### R15.6 Console additions

- **Experiments:** create, schedule, monitor, stop; variant configuration; exposure and metric views; guardrail status; archive.
- **Research data:** dataset builds, export history, access log, opt-out counts.
- New staff roles: experiment owner (create and run), researcher (read de-identified data only). Neither can see personal data or act on accounts.

### R15.7 Acceptance criteria

- **US-51 · Notice and opt-out:** sign-up contains no research consent step. The privacy notice and terms describe research and experiment use. An account that has switched on the opt-out appears in no research dataset built afterwards and in no experiment analysis; play is unaffected.
- **US-52 · Stable, honest assignment:** a player sees the same variant on every device and session for the life of an experiment; exposure is recorded once; an order placed under a fee or delivery variant keeps that variant's terms after the experiment ends.
- **US-53 · Integrity under experiment:** with any combination of active experiments, ledger reconciliation, NPC separation, and the authorisation matrix pass unchanged. A guardrail breach stops the experiment without a deploy.
- **US-54 · De-identification:** the research dataset contains none of the removed fields; research ids differ from production ids and cannot be joined to them with researcher access; a region with fewer than 10 accounts is not named.
- **US-55 · Separation of duties:** a researcher cannot open any account, order, address or console action; a support agent cannot export a research dataset.

---

## R16. Super Admin module

### R16.1 What existed before this section

Partly planned. The event pipeline, daily rollups and metric definitions were specified (§7.10, §7.15), the Console had a Home page and an Analytics area (R7), and usage by place and experiments were added (R7.1, R15). What was missing: a top-level owner role, one place that brings every dashboard together, a defined analytics engine behind those dashboards, and the controls only the platform owner should hold. This section adds them.

### R16.2 Role

The Super Admin is the platform owner: the highest staff role, above the area roles in R7. There should be at least two Super Admin accounts when a second trusted person exists; one is acceptable for a solo builder under the safeguards in R16.6.

A Super Admin can do everything any Console role can, plus the owner-only functions in R16.3. A Super Admin still **cannot**: edit a balance, read or set a card PIN, see a decrypted birthdate or address without the audited view, alter or delete the audit log, or bypass ledger rules. Those limits apply to every human and are enforced by the system, not by policy.

### R16.3 Owner-only functions

| Area | Functions |
|---|---|
| Command centre | The main dashboard (R16.4): health of the product, economy, platform and security on one page |
| Staff and access | Invite and remove staff, assign roles, force sign-out, review who has which permission, see last activity per staff member |
| Platform controls | Kill switches, maintenance and browse-only mode, feature flags, announcement banner |
| Configuration approvals | Approve or reject economy-affecting changes and platform coupon budgets raised by other roles |
| Experiments and research | Approve experiments, stop any experiment, approve research dataset exports (R15) |
| Security centre | Audit log search, sign-in history for staff, failed-PIN and rate-limit activity, suspicious-account queue, active staff sessions, secret-rotation and backup status |
| Data operations | Backup and restore-drill status, reconciliation history, deletion queue, data-retention job status |
| Usage and cost | Consumption against each free-tier limit (database size, storage, email, SMS spend), with warnings before a limit is reached |

### R16.4 Dashboards

One home dashboard plus focused dashboards. Every chart states its period, time zone, data freshness and source, and has an equivalent table (§7.15 design rules). Fictional rupees and real rupees (SMS and other real costs) are never shown in the same chart.

| Dashboard | Key measures |
|---|---|
| Home (command centre) | North-star metric (weekly creators with at least one qualified human buyer, §4.1); active players today / 7 days / 30 days; sign-ups; orders; checkout success rate; ledger reconciliation status; open alerts; a "last 15 minutes" strip |
| Growth and retention | Visitors, sign-up funnel step by step (email, phone, birthdate, first purchase), activation, day-1/7/30 retention by weekly cohort, returning players |
| Shopping | Orders, fictional sales value, average order value, cart-to-order conversion, cart abandonment by step, search with no results, top products and categories |
| Payments | Success rate by method, decline reasons, time to pay, PIN and code failures, lockouts |
| Delivery and membership | Speed mix, Zap eligibility and take-up, delivery fees collected, Delulu Plus members and renewals |
| Promotions | Coupon redemptions, discount given, platform-coupon spend against budget, sale-price usage |
| Merchants and creators | Unlock rate by path, companies registered, first-listing time, creators with and without a human buyer, brand unlocks, warehouse use, top stores |
| Economy | Total supply, mint by source and sink by source, mint/sink ratio, balance distribution, share held by the top 1%, price distribution, inactive balances |
| Places | Usage by country, region and city (R7.1) |
| Experiments | Running experiments, exposure, results, guardrail status (R15) |
| Trust and safety | Moderation queue and age, reports, appeals and outcomes, publishing rejections, linked-account flags |
| Security | Staff sign-ins, privileged actions, failed PIN and code attempts, rate-limit hits, blocked requests, sessions revoked |
| Platform health | Page and API speed against targets (§7.11), error rate, background-job delay, cache effectiveness, availability, free-tier usage |
| NPC sandbox | Simulation runs and outcomes, always separate and labelled (§7.6) |

### R16.5 Analytics engine

The dashboards are served by one engine rather than by hand-written queries per chart.

- **Metric catalogue.** Every metric has one definition: name, plain-language meaning, how it is calculated, which breakdowns it allows (time, place, category, method, source, cohort, experiment variant), which sources it includes (PLAYER by default; NPC and STAFF only when explicitly chosen), and a version. A number on any dashboard, export or experiment report traces back to one catalogue entry (§7.15).
- **Pre-computed aggregates.** Metrics are calculated ahead of time per hour and per day, so dashboards load quickly and never read individual player records.
- **One query interface.** A dashboard asks for metric, breakdowns, filters, period and comparison period. Only catalogue metrics and allowed breakdowns can be requested; there is no free-form query box.
- **Honest numbers.** Late events, reversals and fraud exclusions restate history, and the dashboard shows "as of" time (§7.15). Missing data is "unavailable", never zero. Comparisons with no baseline say so.
- **Privacy built in.** Dashboards show aggregates only; small groups are suppressed under the minimum-count rule (R7.1). Opening an individual account from a dashboard goes through the Customers permission and is audit-logged.
- **Saved views and exports.** A Super Admin can save a filtered view, schedule nothing in this release, and export any chart's table as CSV under the export rules of §7.15.
- **Alerts.** A threshold can be set on any catalogue metric (for example checkout success below 99.5%, mint/sink ratio above a limit, SMS spend above the daily ceiling, moderation queue age). Alerts appear in the command centre and are sent by email.
- **Near-live strip.** A small set of counters (sign-ups, orders, payment failures, errors) refreshes about every 30 seconds; everything else is hourly or daily.

Deferred: custom chart builder, scheduled email reports, forecasting, per-merchant benchmarking.

### R16.6 Safeguards for the most powerful account

- Separate identity from any player account, on the admin site, with a passkey; no email-link-only sign-in.
- Every Super Admin sign-in and every owner-only action is audit-logged and triggers an email alert to all Super Admins.
- **Two-person rule, or a delay when there is only one person.** Actions that mint currency, change economy rules, export research data or grant the Super Admin role need a second Super Admin's approval. Where only one Super Admin exists, the action is instead queued for 24 hours, announced by email, cancellable during that time, and then applied. A stolen session therefore cannot cause immediate irreversible damage.
- Short sessions and re-sign-in before any owner-only action.
- The last Super Admin cannot be removed or demoted.
- An offline recovery procedure for a lost passkey, documented and tested before launch.

### R16.7 Acceptance criteria

- **US-56 · Role limits:** a Super Admin can reach every Console area; no other role can reach owner-only functions by any route. A Super Admin has no way to edit a balance, read a PIN, or change or delete an audit entry.
- **US-57 · One definition per number:** the same metric, period and filters show the same value on the home dashboard, its focused dashboard and its CSV export. NPC and staff activity are excluded unless explicitly selected. A request for a metric or breakdown not in the catalogue is refused.
- **US-58 · Reconciled dashboards:** fictional sales, fees and mint/sink totals on the Economy and Shopping dashboards equal the ledger for the same period and as-of time.
- **US-59 · Dashboard privacy:** no dashboard, tooltip or export shows an individual player's data; a group below the minimum count is suppressed; opening an account from a dashboard is audit-logged.
- **US-60 · Owner safeguards:** with one Super Admin, a minting action is queued, emailed, cancellable for 24 hours and then applied once; with two, it needs the second person. Every Super Admin sign-in sends an alert. The last Super Admin cannot be removed.
- **US-61 · Alerts and freshness:** an alert fires once when its threshold is crossed and clears when it recovers; every chart shows its as-of time; delayed analytics never block checkout (§7.15).

---

## R14. Sources for this revision

Researched 20 November 2026 from search summaries; primary pages were not opened, so treat details as indicative.

- Shopify admin overview: https://help.shopify.com/en/manual/shopify-admin/shopify-admin-overview
- Adobe Commerce (Magento) cart price rules and coupon codes: https://experienceleague.adobe.com/docs/commerce-admin/marketing/promotions/cart-rules/price-rules-cart.html
- Adobe Commerce catalog price rules: https://experienceleague.adobe.com/docs/commerce-admin/marketing/promotions/catalog-rules/price-rules-catalog.html
- BigCommerce features and shipping promotions: https://www.bigcommerce.com/features/all/ · https://www.bigcommerce.com/blog/shipping-promotions-flexible-discounts-that-increase-conversions/
- Razorpay test-mode integration (mock bank page, test instruments): https://razorpay.com/docs/payments/payment-gateway/web-integration/custom/test-integration
- Quick commerce and dark stores: https://yourstory.com/2026/04/inside-dark-stores-blinkit-zepto-how-10-minute-delivery-works · https://cmr.berkeley.edu/2026/01/the-dark-store-revolution-how-indias-10-minute-economy-is-redefining-retail-infrastructure/
- Marketplace order splitting: https://docs.mercurjs.com/platform/order-group/concepts/order-splitting · https://docs.vendure.io/current/core/how-to/multi-vendor-marketplaces.md
- Platform-funded discounts: https://racklify.com/encyclopedia/what-is-a-platform-funded-discount-models-and-how-it-works/
