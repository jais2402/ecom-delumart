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
| Cards and methods | Delulu Card freeze/unfreeze/replace; DeluluPay ID; default method |
| Delivery spots | Saved fictional delivery spots (R5.2) |
| Membership | Delulu Plus status, expiry, renew |
| Collection and saves | As §6.3 and US-09 |
| Privacy and security | Active sessions and sign-out everywhere, privacy flags, data export, account deletion (US-12) |
| Notifications | In-app notification history and preferences |

"Wallet" and "bank balance" remain two views of one ledger balance (§1.2). Orders, Payments and Transactions are three views of the same committed records and must reconcile: one seller order ↔ one share of one successful payment ↔ the corresponding statement rows.

---

## R4. DeluluPay payment simulator

### R4.1 Intent

Checkout should feel like paying online in India: choose a method, get sent to the bank, authenticate, see a result with a reference number, find it in payment history. It remains an internal game system backed only by the player's fictional bank balance. No method creates money, grants credit, or connects to any real network (§7.13 unchanged).

### R4.2 Methods

| Method | Experience | Notes |
|---|---|---|
| Delulu Card | Pick the saved card → redirected to a "Delulu Bank SecureCheck" page → enter a six-digit code | Default. The code is shown in the in-app bank inbox on the same device. |
| DeluluPay ID | Pick or type a DeluluPay ID such as `handle@delulu` → an approval request appears from the bank → Approve or Decline | Mirrors a collect-request flow. |
| Net banking | Choose Delulu Bank → simulated bank page showing account alias and amount → Approve or Decline | Further banks appear here when enabled (§7.13 future banks). |
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

- The code is generated by the server, valid for three minutes, single use, three attempts, with resend allowed after 30 seconds.
- It is delivered only inside the app. No SMS, email or push message carrying a code is ever sent, so the product cannot be mistaken for, or abused as, a real bank message.
- The signed-in session remains the real authority for the payment (§7.13). The code step is validated server-side and is part of the experience, not a second security factor.

### R4.5 Never collect real payment data

This replaces the v1.4 sentence "Do not fabricate OTP messages" with stricter, more specific rules:

- There is no field anywhere that accepts a card number, expiry date, CVV, UPI PIN, ATM PIN, net-banking password or real bank account number.
- The player never **chooses** a numeric secret. Every code is system-generated and displayed, so nobody can type a real PIN out of habit.
- Any free-text field in checkout rejects input that looks like a card number or a real UPI handle.
- DeluluPay IDs end in `@delulu`; card and account aliases stay non-numeric (§7.13). No real bank, card-network or payment-app names or logos.
- Every payment page carries "In-game payment · fictional money".

### R4.6 Test scenarios

Staff and staging accounts can force outcomes (decline, bank unavailable, slow bank, wrong-code lockout) through reserved test DeluluPay IDs and a scenario setting, in the way payment gateways provide test instruments. Scenarios are never applied randomly to players. A method can be put into scheduled "bank maintenance" from the back office; players see an honest unavailable state.

---

## R5. Simulated delivery

### R5.1 Contract

Nothing physical exists and nothing real is shipped. Delivery is a simulation that gives an order a journey. v1.4's sentence "no physical delivery … or shipping addresses" (§1.1) is amended to: **no physical delivery and no real addresses; delivery is simulated to fictional delivery spots.** Microcopy changes from "Nothing ships" to "Nothing real ships — delivery is simulated."

Ownership, creator-threshold evaluation, seller proceeds, brand-qualifying revenue and collector counts are all still settled at payment commit (§7.4). Delivery changes presentation only: an item shows as "Arriving" until delivered, then appears on the shelf with its receipt reveal.

### R5.2 Delivery spots, not addresses

A delivery spot is chosen from lists: a fictional locality (for example "Cloud Nine Heights", "Monsoon Jar Lane") and a fictional landmark. There is no free-text address, pincode, phone number or map location. This keeps the v1.4 privacy position of collecting no address or location data (§7.7).

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
| §1.1 "no physical delivery … or shipping addresses" | Simulated delivery to fictional delivery spots (R5). Still no physical delivery, real address or location data. |
| §6.4 "Fictional money only. Nothing ships." | "Fictional money only. Nothing real ships — delivery is simulated." |
| §7.1 Shopping: buy-now; multi-item cart P1 | Cart is P0 (R2.2). Gifting, auctions and resale stay out. |
| §7.2 J1 "Receipt and collection update" immediately | Ownership is immediate; the item shows as "Arriving" until its simulated delivery completes (R5.1). |
| §7.4 fee formula | Fee is on the list price after seller-funded discounts (R6.6). Delivery fees and membership are new SINK events; platform coupons are a new MINT event. Reconciliation identity gains these terms. |
| §7.5 limits | 100 completed purchases/day counts cart lines. Adds coupon-attempt and authentication-attempt limits. |
| §7.13 "no SMS, email OTP or additional PIN"; "Do not fabricate OTP messages" | An in-app, system-generated code step is added (R4.4). The prohibition on real-world messages and real credentials is kept and tightened (R4.5). |
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
| DeliverySpot | owner, locality code, landmark code; no free text |
| PaymentMethodConfig | method, enabled, order, limits, maintenance window; versioned |
| PaymentChallenge | attempt, code hash, expiry, attempts used; single use |
| Coupon / CouponRedemption | scope MERCHANT or PLATFORM, owner company or campaign, rule, limits; unique (coupon, buyer); redemption linked to seller order and journal |
| PromoCampaign | budget, spent, approvals; spent ≤ budget enforced transactionally |
| Membership | user, period start/end, purchase journal; one active per user |
| PriceHistory | product, price, effective period; source for reference-price rule |
| ConsoleConfigChange | area, before/after, config version, actor, approver, reason |

**New commands (outline)**

`GET/PUT /cart`, `POST /cart/lines`, `DELETE /cart/lines/:id`, `POST /cart/coupon`; `GET/POST/DELETE /account/delivery-spots`; `GET /delivery-options` (for a cart); `POST /checkout-sessions` now accepts a cart, delivery choices, coupon and method; `POST /checkout-sessions/:id/challenge` and `/challenge/verify`; `GET /orders/:id/tracking`; `POST /memberships`; `POST /companies/:id/coupons` and `PATCH …/:id`; `PUT /products/:id/shipping`; `PUT /products/:id/sale-price`; `PUT /warehouses/:id/zap-hub`; staff: `/console/…` for catalog, merchandising, promotions, shipping, payments, economy configuration.

New stable error codes: `CART_CHANGED`, `COUPON_INVALID`, `COUPON_NOT_APPLICABLE`, `DELIVERY_UNAVAILABLE`, `METHOD_UNAVAILABLE`, `METHOD_LIMIT_EXCEEDED`, `CHALLENGE_FAILED`, `CHALLENGE_EXPIRED`, `CHALLENGE_LOCKED`, `MEMBERSHIP_ACTIVE`, `REFERENCE_PRICE_INELIGIBLE`.

**New events:** `cart_updated`, `coupon_applied / coupon_rejected / coupon_redeemed`, `payment_method_selected`, `payment_challenge_issued / passed / failed`, `shipment_created / shipment_stage_changed / shipment_delivered`, `membership_purchased / membership_expired`, `sale_price_set`, `console_config_changed`. Purchase events gain discount, delivery-fee and speed fields. Delivery fees and membership are reported as sinks, never as sales.

---

## R11. Acceptance criteria

- **US-33 · Cart checkout:** a cart with three products from two sellers produces one order group, two seller orders, one payment and one balanced journal. If one line sells out before payment, nothing is debited and the cart shows the change. Repeating the request returns the same order group.
- **US-34 · Account truth:** every seller order in Orders maps to one successful payment in Payments and to statement rows whose sum equals the amount paid. A failed attempt appears in Payments with a reason and nowhere in the statement.
- **US-35 · Payment methods:** each enabled method completes a purchase with the same ledger result. A disabled method cannot be used by calling the API directly. Exceeding a method limit declines with no debit.
- **US-36 · Authentication step:** a correct code proceeds to payment; three wrong codes fail the attempt with no debit; an expired code cannot be used; a code cannot be reused or used on another attempt. No code is ever sent outside the app.
- **US-37 · No real payment data:** no page contains a field for card number, expiry, CVV, PIN or password. Pasting a 16-digit number or a real-format UPI handle into any checkout field is rejected.
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
| Real-credential rule | No field accepts real payment data; no user-chosen numeric secret | Proposed; security/legal |
| Delivery | Simulated; Standard 24 h, Express 2 h, Zap 10 min; fees to SINK | User requirement; times and fees proposed; product/economy |
| Delivery spots | Fictional lists only, no free text | Proposed; privacy |
| Membership name and price | "Delulu Plus", ₹2 lakh / 30 days, manual renewal | Name provisional (the requested "Prime" is another company's brand); product/legal |
| Cancellations and returns | None; staff reversal only | Carried from v1.4; product |
| Coupons | One code per checkout; merchant coupons seller-funded; platform coupons MINT-funded with budget | User requirement; rules proposed; economy |
| Back office | Commerce Console, role-separated | User requirement; scope proposed; product/engineering |

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
