import { Heart, LogOut, ShoppingCart, Store, User } from "lucide-react";
import type { ComponentPropsWithRef } from "react";
import { Icon } from "../../atoms/Icon";
import { LogoMark } from "../../atoms/LogoMark";
import { Skeleton } from "../../atoms/Skeleton";
import { cn } from "../../lib/cn";
import { BalancePill } from "../../molecules/BalancePill";
import type { CategoryLink } from "../../molecules/CategoryThumb";
import { SearchBar } from "../../molecules/SearchBar";
import { CategoryMenu } from "../CategoryMenu";
import { UtilityBar, type UtilityBarProps } from "../UtilityBar";

export type SiteHeaderProps = Omit<ComponentPropsWithRef<"header">, "children"> & {
  /** The balance to show; null hides the chip (signed out, or not known yet). */
  balancePaise: bigint | null;
  /** Reserve the chip's space while the balance loads, so the header does not jump. */
  balanceLoading?: boolean;
  /** Text of the account link: "Account" when signed in, "Sign in" otherwise. */
  accountLabel?: string;
  /** When set, a "Sign out" button is shown. */
  onSignOut?: () => void;
  cartCount: number;
  onSearch: (query: string) => void;
  searchDefaultValue?: string;
  homeHref?: string;
  cartHref?: string;
  accountHref?: string;
  /** When set, a "Sell" link is shown (to the creator access page). */
  sellHref?: string;
  /** When set, a "Saved" heart link is shown. */
  savedHref?: string;
  /** When given, the Categories button and its dropdown are shown. */
  categories?: readonly CategoryLink[];
  /** When given, a thin announcement strip (one message and links) is shown above the band. */
  utility?: Pick<UtilityBarProps, "message" | "links">;
  /** Set when a MobileTabBar is on the page: the cart and account links then leave the header below 768px. */
  withTabBar?: boolean;
};

const control =
  "relative inline-flex min-h-touch min-w-touch items-center justify-center gap-2 rounded-md px-2 font-body text-sm font-medium text-fg-on-band transition-colors duration-fast hover:bg-band-hover focus-visible:outline-fg-on-band";

/**
 * A thin brand-coloured announcement strip, then a solid brand band with the logo, a Categories button, a large pill
 * search, the wallet chip and outline icon actions. Wraps into rows so nothing overflows at 320px.
 * From 768px up it is sticky and the strip scrolls away.
 */
export function SiteHeader({
  balancePaise,
  balanceLoading = false,
  accountLabel = "Account",
  onSignOut,
  cartCount,
  onSearch,
  searchDefaultValue,
  homeHref = "/",
  cartHref = "/cart",
  accountHref = "/account",
  sellHref,
  savedHref,
  categories,
  utility,
  withTabBar = false,
  className,
  ...props
}: SiteHeaderProps) {
  const desktopOnly = withTabBar ? "max-md:hidden" : "";
  return (
    <header className={cn("z-40 bg-surface text-fg md:sticky md:-top-8", className)} {...props}>
      {utility ? <UtilityBar {...utility} /> : null}
      <div className="bg-band text-fg-on-band">
        <div className="mx-auto flex max-w-content flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 md:flex-nowrap md:gap-4">
          <a
            href={homeHref}
            className="inline-flex min-h-touch items-center gap-2 rounded-md font-body text-2xl font-bold text-fg-on-band focus-visible:outline-fg-on-band"
          >
            <LogoMark tone="onBand" />
            <span className="sr-only min-[380px]:not-sr-only">DeluluMart</span>
          </a>
          {categories && categories.length > 0 ? (
            <CategoryMenu categories={categories} className="order-last md:order-none" />
          ) : null}
          <SearchBar
            variant="pill"
            onSearch={onSearch}
            {...(searchDefaultValue !== undefined ? { defaultValue: searchDefaultValue } : {})}
            className={cn(
              "order-last min-w-0 max-md:basis-full md:order-none md:max-w-3xl md:flex-1 md:basis-0",
            )}
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
                </a>
              ) : null}
              <a
                href={cartHref}
                className={cn(control, desktopOnly)}
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
              </a>
              {sellHref ? (
                <a href={sellHref} className={control}>
                  <Icon icon={Store} />
                  <span className="sr-only md:not-sr-only">Sell</span>
                </a>
              ) : null}
              <a href={accountHref} className={cn(control, desktopOnly)}>
                <Icon icon={User} />
                <span className="sr-only sm:not-sr-only">{accountLabel}</span>
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
    </header>
  );
}
