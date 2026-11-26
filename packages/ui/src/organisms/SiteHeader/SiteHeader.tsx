import { Heart, LogOut, ShoppingCart, User } from "lucide-react";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { Icon } from "../../atoms/Icon";
import { LogoMark } from "../../atoms/LogoMark";
import { Skeleton } from "../../atoms/Skeleton";
import { cn } from "../../lib/cn";
import { BalancePill } from "../../molecules/BalancePill";
import type { CategoryLink } from "../../molecules/CategoryThumb";
import { DeliveryPill, type DeliveryPillProps } from "../../molecules/DeliveryPill";
import { LinkMenu, type LinkMenuItem } from "../../molecules/LinkMenu";
import { SearchBar, type SearchBarProps } from "../../molecules/SearchBar";
import { CategoryMenu } from "../CategoryMenu";

export type SiteHeaderProps = Omit<ComponentPropsWithRef<"header">, "children"> & {
  /** The balance to show; null hides the chip (signed out, or not known yet). */
  balancePaise: bigint | null;
  /** Reserve the chip's space while the balance loads, so the header does not jump. */
  balanceLoading?: boolean;
  /** Text of the account link: "Account" when signed in, "Sign in" otherwise. It is also the link's accessible name. */
  accountLabel?: string;
  /** When set, a "Sign out" button is shown. */
  onSignOut?: () => void;
  cartCount: number;
  /** The cart's total as formatted text, shown under the cart icon when the browser already knows it. */
  cartTotalLabel?: string;
  onSearch: (query: string) => void;
  searchDefaultValue?: string;
  /** Where the search form goes when JavaScript is not running (a GET form with the field named q). */
  searchAction?: string;
  /** Suggestions under the search field; see SearchBar. */
  suggestions?: SearchBarProps["suggestions"];
  onQueryChange?: SearchBarProps["onQueryChange"];
  onSelectSuggestion?: SearchBarProps["onSelectSuggestion"];
  homeHref?: string;
  cartHref?: string;
  accountHref?: string;
  /** When set, a "Saved / My items" heart link is shown. */
  savedHref?: string;
  /** The delivery pill beside the logo and its popover. */
  delivery?: Pick<DeliveryPillProps, "label" | "speeds" | "helpHref">;
  /** When given, the Departments pill and its dropdown are shown in the sub-navigation. */
  categories?: readonly CategoryLink[];
  /** When given, a Services pill and its dropdown are shown in the sub-navigation. */
  services?: readonly LinkMenuItem[];
  /** Plain text links after the pills, from 1024px. */
  quickLinks?: readonly LinkMenuItem[];
  /** Set when a MobileTabBar is on the page: the account link then leaves the header below 768px. */
  withTabBar?: boolean;
};

const control =
  "relative inline-flex min-h-touch min-w-touch items-center justify-center gap-2 rounded-md px-2 font-body text-fg-on-band transition-colors duration-fast hover:bg-band-hover focus-visible:outline-fg-on-band";

/** Two lines of text beside an icon, from 1024px: a small line over a bold one. Hidden from assistive technology; the link carries the name. */
function Lines({ top, bottom }: { top: string; bottom: string }): ReactNode {
  return (
    <span aria-hidden="true" className="hidden flex-col text-left leading-tight lg:flex">
      <span className="text-xs">{top}</span>
      <span className="text-sm font-bold">{bottom}</span>
    </span>
  );
}

/**
 * One brand band with the logo, a delivery pill, a wide white pill search and two-line actions
 * (Saved / My items, Sign in / Account, the cart with its count and total), then a white
 * sub-navigation row of pills (Departments, Services) and a few text links. Rows wrap so nothing
 * overflows at 320px; the sub-navigation scrolls sideways on phones. Sticky from 768px.
 */
export function SiteHeader({
  balancePaise,
  balanceLoading = false,
  accountLabel = "Account",
  onSignOut,
  cartCount,
  cartTotalLabel,
  onSearch,
  searchDefaultValue,
  searchAction,
  suggestions,
  onQueryChange,
  onSelectSuggestion,
  homeHref = "/",
  cartHref = "/cart",
  accountHref = "/account",
  savedHref,
  delivery,
  categories,
  services,
  quickLinks,
  withTabBar = false,
  className,
  ...props
}: SiteHeaderProps) {
  const desktopOnly = withTabBar ? "max-md:hidden" : "";
  const hasSubNav = Boolean(
    (categories && categories.length > 0) ||
      (services && services.length > 0) ||
      (quickLinks && quickLinks.length > 0) ||
      delivery,
  );
  return (
    <header className={cn("z-40 bg-surface text-fg md:sticky md:top-0", className)} {...props}>
      <div className="bg-band text-fg-on-band">
        <div className="mx-auto flex max-w-content flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 md:flex-nowrap md:gap-4">
          <a
            href={homeHref}
            className="inline-flex min-h-touch items-center gap-2 rounded-md font-body text-2xl font-bold text-fg-on-band focus-visible:outline-fg-on-band"
          >
            <LogoMark tone="onBand" />
            <span className="sr-only min-[380px]:not-sr-only">DeluluMart</span>
          </a>
          {delivery ? <DeliveryPill {...delivery} className="max-lg:hidden" /> : null}
          <SearchBar
            variant="pill"
            onSearch={onSearch}
            {...(searchAction ? { action: searchAction, method: "get" } : {})}
            {...(searchDefaultValue !== undefined ? { defaultValue: searchDefaultValue } : {})}
            {...(suggestions ? { suggestions } : {})}
            {...(onQueryChange ? { onQueryChange } : {})}
            {...(onSelectSuggestion ? { onSelectSuggestion } : {})}
            className="order-last min-w-0 max-md:basis-full md:order-none md:max-w-3xl md:flex-1 md:basis-0"
          />
          <div className="ml-auto flex min-w-0 items-center gap-1 md:ml-0 md:gap-2">
            {balancePaise !== null ? (
              <BalancePill balancePaise={balancePaise} tone="band" />
            ) : balanceLoading ? (
              <Skeleton className="h-11 w-36 max-w-full bg-band-hover" />
            ) : null}
            <nav aria-label="Account and cart" className="flex items-center gap-1">
              {savedHref ? (
                <a href={savedHref} className={cn(control, "max-md:hidden")} aria-label="Saved">
                  <Icon icon={Heart} />
                  <Lines top="Saved" bottom="My items" />
                </a>
              ) : null}
              <a href={accountHref} className={cn(control, desktopOnly)} aria-label={accountLabel}>
                <Icon icon={User} />
                <Lines top={accountLabel === "Account" ? "Your" : accountLabel} bottom="Account" />
              </a>
              <a
                href={cartHref}
                className={cn(control, "flex-col gap-0 py-1")}
                aria-label={`Cart, ${cartCount} ${cartCount === 1 ? "item" : "items"}`}
              >
                <span className="relative">
                  <Icon icon={ShoppingCart} />
                  <span
                    aria-hidden="true"
                    className="absolute -top-2 -right-3 min-w-5 rounded-pill bg-sun px-1 text-center text-xs font-bold text-fg-on-sun"
                  >
                    {cartCount}
                  </span>
                </span>
                {cartTotalLabel ? (
                  <span aria-hidden="true" className="hidden text-xs leading-tight md:block">
                    {cartTotalLabel}
                  </span>
                ) : null}
              </a>
              {onSignOut ? (
                <button type="button" onClick={onSignOut} className={control}>
                  <Icon icon={LogOut} />
                  <span className="sr-only md:not-sr-only">Sign out</span>
                </button>
              ) : null}
            </nav>
          </div>
        </div>
      </div>
      {hasSubNav ? (
        <div className="border-b border-border bg-surface">
          <div className="mx-auto flex max-w-content items-center gap-2 overflow-x-auto px-4 py-2 md:overflow-visible [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {delivery ? (
              <DeliveryPill {...delivery} tone="plain" className="shrink-0 max-md:hidden lg:hidden" />
            ) : null}
            {categories && categories.length > 0 ? <CategoryMenu categories={categories} /> : null}
            {services && services.length > 0 ? (
              <LinkMenu label="Services" panelLabel="All services" links={services} />
            ) : null}
            {quickLinks && quickLinks.length > 0 ? (
              <nav aria-label="Popular departments" className="hidden lg:block">
                <ul className="flex items-center gap-1">
                  {quickLinks.map((link) => (
                    <li key={link.href}>
                      <a
                        href={link.href}
                        className="inline-flex min-h-touch items-center rounded-pill px-3 font-body text-sm text-fg hover:bg-action-soft hover:underline"
                      >
                        {link.name}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            ) : null}
          </div>
        </div>
      ) : null}
    </header>
  );
}
