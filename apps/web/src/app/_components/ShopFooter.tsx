import { type FooterGroup, SiteFooter } from "@delulu/ui";
import { CATEGORY_LINKS } from "../_lib/category-style";

const GROUPS: readonly FooterGroup[] = [
  { title: "Categories", links: CATEGORY_LINKS.map((c) => ({ label: c.name, href: c.href })) },
  {
    title: "Shop",
    links: [
      { label: "All products", href: "/search" },
      { label: "Your cart", href: "/cart" },
    ],
  },
  {
    title: "Play",
    links: [
      { label: "Sell on DeluluMart", href: "/sell" },
      { label: "Your wallet", href: "/account/wallet" },
      { label: "Your orders", href: "/account/orders" },
    ],
  },
];

/** The site footer with the storefront's category links. */
export function ShopFooter() {
  return <SiteFooter groups={GROUPS} />;
}
