# Daydream — the DeluluMart design system

Daydream is the component and token system for every DeluluMart surface: storefront, account, payment pages, merchant portal and back office. It lives in `packages/ui` and follows atomic design.

## 1. Character

A serious, busy online store in the family of the big Indian marketplaces, in its own colours. The page ground is a light cool grey; every section sits in a white panel with a small radius and no heavy shadow (home sections, rails, the product page columns, the category grid). One deep royal-blue band carries the header and the footer promise band; a brighter blue (`action`) is for links, focus, selected states and the round search button. Purchase buttons follow the marketplace convention: "Add to cart" in saffron-amber, "Buy now" in a deeper orange, both with near-black text. Magenta-pink (`accent`) is only for small badges and tags (Zap, exclusive edition). Prices are near-black and bold; green is only for availability; yellow is only for the cart-count badge.

Small radii (6 to 8px), flat surfaces, 1px rules, one clean sans (Inter) for everything: bold headings with normal tracking, regular-weight product names. No gradients (except the dark scrim under captions on photos), no tilted or floating elements.

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
| Radius | `sm 4`, `md 6`, `lg 8`, `xl 12`, `pill` (the search field only) |
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

**Molecules** — FormField, SearchBar (default and pill), PriceBlock, BalancePill, StockBadge, SourceBadge, DeliveryOption, PaymentMethodOption, CouponInput, PinField, CardNumber, Alert, EmptyState, Stat, StepIndicator, TimelineItem, Breadcrumbs, Pagination, Tabs, Dialog, CategoryTile, TrustItem, SectionHeading, StepCard, ProductCardSkeleton.

**Organisms** — UtilityBar, SiteHeader, CategoryMenu, MobileTabBar, SiteFooter, ProductCard, ProductGrid, ProductRail, HomeHero, PromoTile, TrustStrip, CategoryTiles, HowItWorks, CreatorBand, DeliveryBox, FilterPanel, CartLines, OrderSummary, CheckoutSteps, BankChallenge, TrackingTimeline, DataTable, StatementTable, VirtualCard, SidebarNav, StatGrid, AddressCard, Receipt.

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

- **Header.** A slim white utility row (delivery times on the left, How it works and Sell on DeluluMart on the right), then a royal-blue band: white logo, a Categories button that opens a dropdown of category rows with chevrons (Escape closes it and returns focus; below 768px it is a bottom sheet), a white pill search with a round blue button, then outline icons for Saved, Cart (yellow count badge), Sell and Sign in or Account. Sticky from 768px; the utility row scrolls away. Below 768px the header is compact and a plain fixed bottom tab bar (Home, Categories, Cart, Account) carries the cart and account links.
- **Home.** A white panel of square category pictures; a mosaic of a blue welcome block (amber button) beside three photo tiles with captions on a dark scrim; a featured rail of large photo cards; two banners (amber and blue); product rails; a trust row; how shopping works; a creator section. Each section is a white panel on the grey ground.
- **Rails.** Large bold title with a grey continuation, four cards from 1024px, previous and next buttons at the edges (focusable, `aria-disabled` at the ends).
- **Product card.** No box: a picture on a light tile, name, seller, bold price, a square amber add-to-cart button and a save heart (names unchanged), "In stock" in quiet green, a delivery line and, for Zap-eligible products, a pink Zap tag. Delivery wording comes from the configured delivery durations.
- **Product photos.** Platform products show a photo served from our own origin (`/products`, credits in CREDITS.md) when one exists, through `ProductPicture`; everything else shows the generated art, one clean object per category on a plain light backdrop.
- **Product page.** Breadcrumb; a white panel with the photo and description; a white panel with seller, title, bold price beside its stock badge, a wide amber "Add to cart", an orange "Buy now" (accessible name stays "Buy now"; the price after it is `aria-hidden`), a square save button, and one bordered Delivery box with 1px lines between rows and a bold status line (green for availability).
- **Footer.** A band of three promises in the band blue, then a white section with the logo, link columns (existing pages only) and a thin bottom row with the required fictional-money disclaimer.
