# Daydream — the DeluluMart design system

Daydream is the component and token system for every DeluluMart surface: storefront, account, payment pages, merchant portal and back office. It lives in `packages/ui` and follows atomic design.

## 1. Character

A playful department store for impossible objects, run with a straight face. Warm ivory ground, ink text, electric violet for action, acid lime used sparingly as a highlight. Jokes belong in headlines and product names, never in errors, money or instructions.

Operational surfaces (portal, back office) use the same tokens with denser tables and no celebratory effects.

## 2. Tokens

Defined once as CSS variables in `packages/ui/src/styles/tokens.css`, exposed to Tailwind through the theme. Components use tokens only.

| Group | Tokens |
|---|---|
| Colour, surface | `bg`, `surface`, `surface-raised`, `border`, `border-strong` |
| Colour, text | `fg`, `fg-muted`, `fg-on-action`, `fg-on-highlight` |
| Colour, brand | `action`, `action-hover`, `action-soft`, `highlight` |
| Colour, status | `success`, `warning`, `danger`, `info`, each with a `-soft` background |
| Colour, source | `source-player`, `source-npc` (always paired with a text label) |
| Type family | `font-display` (Space Grotesk), `font-body` (Inter), `font-mono` (JetBrains Mono) |
| Type scale | `xs 12`, `sm 14`, `base 16`, `lg 18`, `xl 20`, `2xl 24`, `3xl 30`, `4xl 36` |
| Space | 4-point scale: `1`=4px … `16`=64px |
| Radius | `sm 4`, `md 8`, `lg 12`, `pill` |
| Shadow | `raised`, `overlay` |
| Motion | `fast 120ms`, `base 200ms`; disabled under reduced-motion |
| Layout | `content 1120px`, `reading 68ch`, `touch 44px` |

Base values (light): background `#FAF8F2`, text `#171717`, action `#5B21B6` with white text, highlight `#D9F75C` with dark text. Dark theme redefines the same tokens; components never branch on theme.

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

**Atoms** — Button, IconButton, Link, Heading, Text, Label, Input, Textarea, Select, Checkbox, Radio, Switch, Badge, Tag, Avatar, Icon, Spinner, Skeleton, Divider, ProgressBar, Price, FictionLabel, VisuallyHidden.

**Molecules** — FormField, SearchBar, PriceBlock, BalancePill, StockBadge, SourceBadge, DeliveryOption, PaymentMethodOption, CouponInput, PinField, CardNumber, Alert, EmptyState, Stat, StepIndicator, TimelineItem, Breadcrumbs, Pagination, Tabs, Dialog.

**Organisms** — SiteHeader, SiteFooter, ProductCard, ProductGrid, FilterPanel, CartLines, OrderSummary, CheckoutSteps, BankChallenge, TrackingTimeline, DataTable, StatementTable, VirtualCard, SidebarNav, StatGrid, AddressCard, Receipt.

**Templates** — ShopLayout, AccountLayout, CheckoutLayout, PortalLayout, ConsoleLayout, BankPageLayout.

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
