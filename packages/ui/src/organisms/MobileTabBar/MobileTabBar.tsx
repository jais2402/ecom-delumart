import { Home, LayoutGrid, ShoppingCart, User } from "lucide-react";
import type { ComponentPropsWithRef } from "react";
import { Icon } from "../../atoms/Icon";
import { cn } from "../../lib/cn";

export type MobileTabKey = "home" | "categories" | "cart" | "account";

export type MobileTabBarProps = Omit<ComponentPropsWithRef<"nav">, "children"> & {
  cartCount: number;
  /** Text of the account tab: "Account" when signed in, "Sign in" otherwise. */
  accountLabel?: string;
  homeHref?: string;
  categoriesHref?: string;
  cartHref?: string;
  accountHref?: string;
  /** The tab for the page being shown, marked as current. */
  current?: MobileTabKey;
};

const tab =
  "relative flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 font-body text-xs font-medium text-fg-muted transition-colors duration-fast hover:text-fg aria-[current=page]:text-action";

/** Fixed bottom navigation for phones: Home, Categories, Cart, Account. Hidden from 768px up, where the header carries these links. */
export function MobileTabBar({
  cartCount,
  accountLabel = "Account",
  homeHref = "/",
  categoriesHref = "/#categories",
  cartHref = "/cart",
  accountHref = "/account",
  current,
  className,
  ...props
}: MobileTabBarProps) {
  const mark = (key: MobileTabKey) => (current === key ? ({ "aria-current": "page" } as const) : {});
  return (
    <nav
      aria-label="Main"
      data-tab-bar=""
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden",
        className,
      )}
      {...props}
    >
      <ul className="mx-auto grid max-w-md grid-cols-4">
        <li>
          <a href={homeHref} className={tab} {...mark("home")}>
            <Icon icon={Home} />
            Home
          </a>
        </li>
        <li>
          <a href={categoriesHref} className={tab} {...mark("categories")}>
            <Icon icon={LayoutGrid} />
            Categories
          </a>
        </li>
        <li>
          <a
            href={cartHref}
            className={tab}
            aria-label={`Cart, ${cartCount} ${cartCount === 1 ? "item" : "items"}`}
            {...mark("cart")}
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
            Cart
          </a>
        </li>
        <li>
          <a href={accountHref} className={tab} {...mark("account")}>
            <Icon icon={User} />
            {accountLabel}
          </a>
        </li>
      </ul>
    </nav>
  );
}
