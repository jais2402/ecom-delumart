import { LogOut, ShoppingCart, User } from "lucide-react";
import type { ComponentPropsWithRef } from "react";
import { Icon } from "../../atoms/Icon";
import { Skeleton } from "../../atoms/Skeleton";
import { cn } from "../../lib/cn";
import { BalancePill } from "../../molecules/BalancePill";
import { SearchBar } from "../../molecules/SearchBar";

export type SiteHeaderProps = Omit<ComponentPropsWithRef<"header">, "children"> & {
  /** The balance to show; null hides the pill (signed out, or not known yet). */
  balancePaise: bigint | null;
  /** Reserve the pill's space while the balance loads, so the header does not jump. */
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
};

const iconLink =
  "inline-flex min-h-touch min-w-touch items-center justify-center gap-2 rounded-md px-2 font-body text-sm font-medium text-fg hover:bg-action-soft";

/** Logo, search, balance, cart and account. Stacks into rows below 640px so nothing overflows at 320px. */
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
  className,
  ...props
}: SiteHeaderProps) {
  return (
    <header className={cn("border-b border-border bg-surface", className)} {...props}>
      <div className="mx-auto flex max-w-content flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <a
          href={homeHref}
          className="inline-flex min-h-touch items-center font-display text-2xl font-bold text-action"
        >
          DeluluMart
        </a>
        <nav aria-label="Account and cart" className="ml-auto flex items-center gap-1 sm:order-3 sm:ml-0">
          <a
            href={cartHref}
            className={iconLink}
            aria-label={`Cart, ${cartCount} ${cartCount === 1 ? "item" : "items"}`}
          >
            <Icon icon={ShoppingCart} />
            <span
              aria-hidden="true"
              className="min-w-5 rounded-pill bg-highlight px-1.5 text-center text-xs font-bold text-fg-on-highlight"
            >
              {cartCount}
            </span>
          </a>
          <a href={accountHref} className={iconLink}>
            <Icon icon={User} />
            <span className="sr-only sm:not-sr-only">{accountLabel}</span>
          </a>
          {onSignOut ? (
            <button type="button" onClick={onSignOut} className={iconLink}>
              <Icon icon={LogOut} />
              <span className="sr-only sm:not-sr-only">Sign out</span>
            </button>
          ) : null}
        </nav>
        <SearchBar
          onSearch={onSearch}
          {...(searchDefaultValue !== undefined ? { defaultValue: searchDefaultValue } : {})}
          className="order-last basis-full sm:order-2 sm:flex-1 sm:basis-0"
        />
        {balancePaise !== null ? (
          <BalancePill balancePaise={balancePaise} className="order-last max-w-full flex-wrap sm:order-4" />
        ) : balanceLoading ? (
          <Skeleton className="order-last h-11 w-48 max-w-full rounded-pill sm:order-4" />
        ) : null}
      </div>
    </header>
  );
}
