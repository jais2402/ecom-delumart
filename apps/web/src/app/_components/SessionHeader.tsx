"use client";

import { SiteHeader } from "@delulu/ui";
import { useRouter } from "next/navigation";
import { useCart } from "../_lib/cart-store";
import { signOut, useSession } from "../_lib/session-store";

/**
 * The site header with the signed-in state filled in after the page has rendered: balance and
 * "Account" when signed in, "Sign in" otherwise. Until the browser has asked, the header shows no
 * personal data (the static HTML never contains any).
 */
export function SessionHeader({ searchDefaultValue }: { searchDefaultValue?: string }) {
  const router = useRouter();
  const session = useSession();
  const cart = useCart();
  const signedIn = session.status === "signedIn";
  return (
    <SiteHeader
      balancePaise={signedIn ? session.balancePaise : null}
      balanceLoading={session.status === "loading"}
      accountHref={signedIn ? "/account" : "/sign-in"}
      accountLabel={signedIn ? "Account" : "Sign in"}
      cartCount={cart.count}
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
  );
}
