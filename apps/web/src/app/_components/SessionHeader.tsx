"use client";

import { formatInrCompact } from "@delulu/core";
import { MobileTabBar, type MobileTabKey, type SearchSuggestion, SiteHeader } from "@delulu/ui";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { CATEGORIES } from "../../data/seed-catalog";
import { useBlockedSellerKeys, withoutBlocked } from "../_lib/blocks-store";
import { useCart } from "../_lib/cart-store";
import { CATEGORY_LINKS } from "../_lib/category-style";
import { parsePaiseOrNull } from "../_lib/money";
import { suggestionsFor } from "../_lib/search-suggestions";
import { signOut, useSession } from "../_lib/session-store";
import { SHOP_CONFIG } from "../_lib/shop-config";
import { DELIVERY_PILL } from "../_lib/speeds";
import { useFullCatalog } from "../_lib/use-full-catalog";

const SERVICES = [
  { name: "Sell on DeluluMart", href: "/sell" },
  { name: "How it works", href: "/#how-it-works" },
  { name: "Your orders", href: "/account/orders" },
  { name: "Your wallet", href: "/account/wallet" },
] as const;

const QUICK_LINKS = CATEGORY_LINKS.slice(0, SHOP_CONFIG.subNav.textLinks).map(({ name, href }) => ({
  name,
  href,
}));

function currentTab(pathname: string): MobileTabKey | undefined {
  if (pathname === "/") return "home";
  if (pathname.startsWith("/cart")) return "cart";
  if (pathname.startsWith("/account") || pathname.startsWith("/sign-in")) return "account";
  return undefined;
}

/**
 * The site header with the signed-in state filled in after the page has rendered: balance and
 * "Account" when signed in, "Sign in" otherwise. Until the browser has asked, the header shows no
 * personal data (the static HTML never contains any). It also looks up search suggestions: when the
 * shopper has typed two characters and paused, the public catalogue is read once (the route the
 * search page uses) and matched in the browser, so what was typed is never sent anywhere. On phones
 * the cart and account links also live in the fixed tab bar rendered right after the header.
 */
export function SessionHeader({ searchDefaultValue }: { searchDefaultValue?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const session = useSession();
  const cart = useCart();
  const blocked = useBlockedSellerKeys();
  const signedIn = session.status === "signedIn";
  const accountHref = signedIn ? "/account" : "/sign-in";
  const accountLabel = signedIn ? "Account" : "Sign in";
  const tab = currentTab(pathname);

  // the cart's total, only when the signed-in cart already carries the server's own figure
  const total = cart.serverMode ? parsePaiseOrNull(cart.server?.preview?.totalPaise) : null;

  const [typed, setTyped] = useState("");
  const [settled, setSettled] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSettled(typed), SHOP_CONFIG.suggest.debounceMs);
    return () => clearTimeout(timer);
  }, [typed]);
  const wanted = settled.trim().length >= SHOP_CONFIG.suggest.minChars;
  const { products } = useFullCatalog(wanted);
  const suggestions: SearchSuggestion[] = useMemo(
    () => suggestionsFor(settled, withoutBlocked(products, blocked), CATEGORIES),
    [settled, products, blocked],
  );

  return (
    <>
      <SiteHeader
        balancePaise={signedIn ? session.balancePaise : null}
        balanceLoading={session.status === "loading"}
        savedHref="/account/saved"
        accountHref={accountHref}
        accountLabel={accountLabel}
        cartCount={cart.count}
        {...(total !== null && cart.count > 0 ? { cartTotalLabel: formatInrCompact(total) } : {})}
        categories={CATEGORY_LINKS}
        services={SERVICES}
        quickLinks={QUICK_LINKS}
        delivery={DELIVERY_PILL}
        withTabBar
        searchAction="/search"
        suggestions={suggestions}
        onQueryChange={setTyped}
        onSelectSuggestion={(suggestion) => router.push(suggestion.href)}
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
