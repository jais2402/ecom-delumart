"use client";

import { MobileTabBar, type MobileTabKey, SiteHeader } from "@delulu/ui";

import { usePathname, useRouter } from "next/navigation";
import { useCart } from "../_lib/cart-store";
import { CATEGORY_LINKS } from "../_lib/category-style";
import { signOut, useSession } from "../_lib/session-store";
import { arrivalPhrase } from "../_lib/speeds";

const UTILITY = {
  items: [`Standard delivery in ${arrivalPhrase("STANDARD")}`, `Zap delivery in ${arrivalPhrase("ZAP")}`],
  links: [
    { label: "How it works", href: "/#how-it-works" },
    { label: "Sell on DeluluMart", href: "/sell" },
  ],
} as const;

function currentTab(pathname: string): MobileTabKey | undefined {
  if (pathname === "/") return "home";
  if (pathname.startsWith("/cart")) return "cart";
  if (pathname.startsWith("/account") || pathname.startsWith("/sign-in")) return "account";
  return undefined;
}

/**
 * The site header with the signed-in state filled in after the page has rendered: balance and
 * "Account" when signed in, "Sign in" otherwise. Until the browser has asked, the header shows no
 * personal data (the static HTML never contains any). On phones the cart and account links live in
 * the fixed tab bar rendered right after the header.
 */
export function SessionHeader({ searchDefaultValue }: { searchDefaultValue?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const session = useSession();
  const cart = useCart();
  const signedIn = session.status === "signedIn";
  const accountHref = signedIn ? "/account" : "/sign-in";
  const accountLabel = signedIn ? "Account" : "Sign in";
  const tab = currentTab(pathname);
  return (
    <>
      <SiteHeader
        balancePaise={signedIn ? session.balancePaise : null}
        balanceLoading={session.status === "loading"}
        sellHref="/sell"
        savedHref="/account/saved"
        accountHref={accountHref}
        accountLabel={accountLabel}
        cartCount={cart.count}
        categories={CATEGORY_LINKS}
        utility={UTILITY}
        withTabBar
        onSearch={(query) => router.push(query ? `/search?q=${encodeURIComponent(query)}` : "/search")}
        {...(signedIn
          ? {
              onSignOut: () => {
                void signOut().finally(() => router.push("/"));
              },
            }
          : {})}
        {...(searchDefaultValue !== undefined ? { searchDefaultValue } : {})}
      />
      <MobileTabBar
        cartCount={cart.count}
        accountHref={accountHref}
        accountLabel={accountLabel}
        {...(tab ? { current: tab } : {})}
      />
    </>
  );
}
