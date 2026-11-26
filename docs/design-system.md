# Daydream — the DeluluMart design system

Daydream is the component and token system for every DeluluMart surface: storefront, account, payment pages, merchant portal and back office. It lives in `packages/ui` and follows atomic design.

## 1. Character

A serious, busy online store in the family of the big Indian marketplaces, in its own colours. The page ground is a light cool grey; every section sits in a white panel with a small radius and no heavy shadow (home sections, rails, the product page columns, the category grid). One deep royal-blue band carries the header and the footer promise band; a brighter blue (`action`) is for links, focus, selected states and the round search button. Purchase buttons follow the marketplace convention: "Add to cart" in saffron-amber, "Buy now" in a deeper orange, both with near-black text. Magenta-pink (`accent`) is only for small badges and tags (Zap, exclusive edition). Prices are near-black and bold; green is only for availability; yellow is only for the cart-count badge.

Fully rounded pill buttons and search field; small radii (6 to 8px) on cards, tiles and panels; flat surfaces, 1px rules, one clean sans (Inter) for everything: bold headings with normal tracking, regular-weight product names. No gradients (except the dark scrim under captions on photos), no tilted or floating elements.

Copy reads like a real store: merchandising and plain retail language. The game's disclosure stays where it is required (the footer line, every payment and checkout page, sign-in and onboarding, the wallet chip's "fictional money" label) and is not repeated elsewhere on the storefront.

Operational surfaces (portal, back office) use the same tokens with denser tables.

## 2. Tokens

Defined once as CSS variables in `packages/ui/src/styles/tokens.css`, exposed to Tailwind through the theme. Components use tokens only. Light and dark are both defined (the `prefers-color-scheme` block and `[data-theme="dark"]`); dark is a neutral charcoal, not tinted.

| Group | Tokens |
|---|---|
| Colour, surface | `bg` (page ground), `surface` (white panels), `surface-raised` (picture backdrops, light grey), `border`, `border-strong` |
| Colour, text | `fg`, `fg-muted`, `fg-on-action`, `fg-on-highlight` |
| Colour, blue | `action`, `action-hover`, `action-soft` (links, focus, selected, search button); `highlight` (focus ring in dark mode) |
| Colour, band | `band`, `band-hover`, `fg-on-band`, `fg-on-band-muted`, `border-on-band` (header and footer promise band) |
| Colour, purchase | `cta`, `cta-hover`, `fg-on-cta` (Add to cart, warm banner); `cta-strong`, `cta-strong-hover`, `fg-on-cta-strong` (Buy now) |
| Colour, badge | `accent`, `accent-soft`, `fg-on-accent` (tags only); `sun`, `fg-on-sun` (cart count only) |
| Colour, ink | `ink`, `fg-on-ink`, `fg-on-ink-muted` (the scrim under captions on photos) |
| Colour, status | `success`, `warning`, `danger`, `info`, each with a `-soft` background; green is for availability |
| Colour, source | `source-player`, `source-npc` (always paired with a text label) |
| Type family | `font-display` and `font-body` are both Inter; `font-mono` (JetBrains Mono) |
| Type scale | `xs 12`, `sm 14`, `base 16`, `lg 18`, `xl 20`, `2xl 24`, `3xl 30`, `4xl 36`; page titles 36px, section titles 30px, product names 16px regular |
| Space | 4-point scale: `1`=4px … `16`=64px |
| Radius | `sm 4`, `md 6`, `lg 8`, `xl 12`, `pill` (buttons, the search field, menu pills) |
| Shadow | `raised` (faint), `overlay` (menus and dialogs) |
| Motion | `fast 120ms`, `base 200ms`; disabled under reduced-motion |
| Layout | `content 1240px`, `reading 68ch`, `touch 44px` |

Base values (light / dark): page ground `#F1F3F6` / `#121214`; panel `#FFFFFF` / `#1B1B1F`; text `#14161A` / `#ECECF0`; band `#1F2F7A` / `#23252B` with white text; action `#2557D6` / `#8FB0FF`; cta (Add to cart) `#FFB21E` / `#FFB21E` with near-black text; cta-strong (Buy now) `#E4570F` / `#F26B2A` with near-black text; accent `#B3175D` / `#FF7AB0` with soft `#FDE7F1` / `#4A1530`. Every text and background pair meets WCAG AA (checked in both themes by `tests/a11y/audit.js`). Components never branch on theme. Focus rings are `focus` (blue, lime in dark mode) and `fg-on-band` (white) on the band.

## 3. Atomic levels

| Level | Definition here | May import | Must not |
|---|---|---|---|
| Atoms | Single-purpose elements: a button, an input, a price | Tokens, utilities | Import other levels; hold business rules |
| Molecules | Small groups of atoms with one job: a labelled field, a delivery option | Atoms | Know about pages or data sources |
| Organisms | Distinct sections of a screen: header, product card, order summary | Atoms, molecules | Fetch data; read global state |
| Templates | Page layouts with slots: shop, account, checkout, portal, console, bank page | Organisms and below | Contain real content |
| Pages | Templates filled with real data, in `apps/web` | Everything | Define new styling |

Import direction is one-way and enforced by lint.

## 4. Inventory

**Atoms** — Button, IconButton, Link, Heading, Text, Label, Input, Textarea, Select, Checkbox, Radio, Switch, Badge, Tag, Avatar, Icon, Spinner, Skeleton, Divider, ProgressBar, Price, ProductArt, CategoryGlyph, LogoMark, FictionLabel, VisuallyHidden.

**Molecules** — FormField, SearchBar (default and pill; a combobox when given suggestions), PriceBlock, BalancePill, StockBadge, SourceBadge, DeliveryOption, PaymentMethodOption, CouponInput, PinField, CardNumber, Alert, EmptyState, Stat, StepIndicator, TimelineItem, CollapsibleBlock, Breadcrumbs, Pagination, Tabs, Dialog, CategoryThumb, TrustItem, SectionHeading, StepCard, ProductCardSkeleton, PromoCard, ScrollRow, LinkMenu, SortMenu, DeliveryPill, FilterTabs.

**Organisms** — SiteHeader, CategoryMenu, MobileTabBar, SiteFooter, ProductCard, ProductGrid, ProductRail, HomeHero, PromoTile, TrustStrip, CategoryThumbs, BrandStory, HowItWorks, CreatorBand, DeliveryBox, FilterPanel, CartLines, OrderSummary, CheckoutSteps, BankChallenge, TrackingTimeline, DataTable, StatementTable, VirtualCard, SidebarNav, StatGrid, AddressCard, Receipt, OrderItemsList.

**Templates** — ShopLayout, HomeLayout, AccountLayout, CheckoutLayout, PortalLayout, ConsoleLayout, BankPageLayout.

## 5. Rules every component follows

1. **Accessible by construction.** Real HTML elements first. Every control has an accessible name, a visible focus ring, and a 44px touch target. Dialogs trap and restore focus. Status changes are announced politely.
2. **States are designed.** Default, hover, focus, active, disabled, loading, error, empty where they apply.
3. **Money is never ambiguous.** `Price` shows compact text (₹2 crore) and carries an exact accessible label (2 crore fictional rupees). Anything showing an amount sits near a `FictionLabel` on the screen.
4. **Source is never colour-only.** Player and simulated-NPC figures always carry a text label.
5. **No real-payment fields.** There is no component for typing a card number, expiry, CVV or bank password. `PinField` is six digits, labelled as a game PIN, and opts out of browser saving. `CardNumber` only displays.
6. **Responsive.** Works from 320px wide. Tables scroll inside their own container; the page never scrolls sideways.
7. **Motion is optional.** Short, purposeful, and removed under reduced-motion.
8. **API shape.** Props are explicit and typed; `className` is accepted and merged; refs are forwarded on atoms; variants use one `variant` and one `size` prop.

## 6. Files

```
packages/ui/src/
  styles/tokens.css, index.css
  lib/cn.ts
  atoms/Button/Button.tsx, Button.test.tsx, index.ts
  molecules/…  organisms/…  templates/…
  index.ts
```

Each component: one file, one colocated test (render, interaction, accessible name), exported through its level's `index.ts`.

## 7. Showcase

`/design-system` in the web app renders every component in its states, in both themes. It is the reference when generating new screens and the first place to look when something seems inconsistent.

## 8. Storefront patterns

- **Header.** One band, no announcement strip. On the band: the logo; a "Standard or Zap delivery" pill (in the sub-navigation from 768px) that opens a small popover listing Standard, Express and Zap with their configured arrival times and a "How it works" link; a wide white pill search with a round blue button; then two-line actions: a heart over "Saved / My items", a person over "Sign in / Account" (the links keep the accessible names "Saved", "Sign in" and "Account"), and the cart icon with its yellow count badge and, when the signed-in cart already carries the server's total, that total beneath it (the name stays "Cart, N items"). The wallet chip and "Sign out" sit with them; below 1440px the chip shows icon and amount only (its label stays in the accessible name) and "Sign out" is icon-only,. Under the band, on white, a sub-navigation row: pill dropdowns "Departments" (the categories) and "Services" (Sell on DeluluMart, How it works, Your orders, Your wallet), then a few plain text links to departments from 1024px. Sticky from 768px; below that the band holds the logo, the wallet chip and cart, the search pill takes its own row, the pills scroll sideways and a fixed bottom tab bar (Home, Categories, Cart, Account) stays. The search is a GET form to `/search`, so it works without JavaScript.
- **Search suggestions.** From two typed characters, after a short pause, the field becomes a combobox: a list of matching departments and products under the pill, read from the public catalogue the search page already uses (matched in the browser; the text is never sent). Arrow keys move through it with focus staying in the field (`aria-activedescendant`), Enter on a row goes there, Enter with no row submits the plain search, Escape closes it.
- **Home.** In order: the promo card row, "Shop by department", "Top picks", two plain rails, "Saved for later" (signed in, only when something is saved), "Recently viewed" (this browser, only when there is history), the promise row, two banners (amber and blue), the brand story, how shopping works, a slim creator band. Each section is a white panel on the grey ground; the gap between them is 24px on phones and 32px from 768px.
- **Promo cards.** A horizontally scrolling row of tall cards, three visible from 1024px with the fourth peeking (about 80% wide on phones): a small eyebrow line, a bold headline over at most three lines, an underlined "Shop now" link (named "Shop now: <product>") and the photo at the bottom. Cards are the band indigo, with one amber card; the first is the welcome-balance message and carries the page's one h1. The rest are the dearest products (count from `HOME_CONFIG.hero`). Previous and next buttons sit at the edges from 768px; the row never advances by itself.
- **Department row.** "Shop by department": soft-square photo thumbnails with a bold name beneath, in a row that scrolls with an arrow button, each linking to its category page.
- **Top picks.** A rail with a group of toggle buttons (`aria-pressed`): "All" (two products per category across prices) and one per category. Choosing one filters lists the page already has; nothing is fetched and the address does not change. The title is not a ranking claim. A category tab shows a "View all" link to that category's page; "All" has none because no page lists the whole catalogue.
- **Rails.** A bold title, one muted subtitle line and an underlined "View all" link at the right (drawn only when a real destination exists); two and a bit cards on phones, four from 768px, six from 1024px; previous and next buttons at the edges (focusable, `aria-disabled` at the ends). While data loads the rail shows grey rounded skeleton blocks in the card's shape.
- **Product card.** No box, in the order shoppers scan it: the picture on a light tile with a round save heart (names unchanged) on its top-right corner and one small soft-pink tag on its top-left, only for states the data has (sold out, low stock, an edition number, else Zap); a small "+ Add" pill in amber (accessible name "Add to cart: <product>"; "In cart" with a check once added); the bold price (green with a struck-through "Was" price only if a real reference price exists); the name over two lines; the seller in small grey. Optional slots for a hook and a rating summary draw nothing unless given. No ratings and no best-seller labels: there is no such data.
- **Sort and results.** Category and search pages show a result count and a "Sort by" pill (Best match, Price low to high, Price high to low, Name A to Z) that orders the products already loaded on the page; prices are compared as bigint paise. The menu uses radio items with arrow-key navigation.
- **Recently viewed.** The last twelve product ids opened are kept in sessionStorage for the tab's session (ids only, never sent anywhere, skipped when the browser signals Global Privacy Control or Do Not Track) and shown from the public catalogue on the home page and under the product page.
- **Promise row.** After the product rails: four items of a soft round icon, a bold title and one muted line; a 2 by 2 grid on phones with the icon above the text.
- **Brand story.** One calm white panel: a short statement of what the store is (only things that are true of it) and a row of figures counted from the catalogue the page loaded (products, categories, shops). A figure that cannot be counted is left out.
- **Product page.** Breadcrumb; a white panel with the photo and description; a white panel with seller, title, bold price beside its stock badge, a wide amber pill "Add to cart", an orange pill "Buy now" (accessible name stays "Buy now"; the price after it is `aria-hidden`), a square save button, and one bordered Delivery box with 1px lines between rows and a bold status line (green for availability).
- **Product photos.** Platform products show a photo served from our own origin (`/products`, credits in CREDITS.md) when one exists, through `ProductPicture`; everything else shows the generated art, one clean object per category on a plain light backdrop.
- **Footer.** A band of three promises in the band blue, then a white section with the logo, link columns (existing pages only) and a thin bottom row with the required fictional-money disclaimer.
- **Shopper flow.** Sign-in, onboarding, cart, checkout, order and account pages share the storefront's language: grey ground, white 8px-radius panels, amber pill for the main action (orange for "Pay now" and the bank "Pay"), white outlined pill for secondary ones. Sign-in and onboarding sit in one white panel under a slim indigo band with a numbered step indicator. The cart lists each seller as a panel of photo rows with the order summary on the right. Checkout shows a numbered step bar, the step in a white panel, and on the right the items with photos and the order summary; below 1024px that summary follows the step as a collapsible block with the total beside its toggle. The order page puts the receipt and address beside the per-seller tracking panels. The account hub has a left navigation panel from 768px and a row of scrolling pills above the content on phones.
