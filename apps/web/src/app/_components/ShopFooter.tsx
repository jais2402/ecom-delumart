import { type FooterGroup, SiteFooter } from "@delulu/ui";
import { CATEGORY_LINKS } from "../_lib/category-style";

const GROUPS: readonly FooterGroup[] = [
  { title: "Categories", links: CATEGORY_LINKS.map((c) => ({ label: c.name, href: c.href })) },
  {
    title: "Shop",
    links: [
      { label: "All products", href: "/search" },
      { label: "Deals", href: "/deals" },
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
  {
    title: "Help and policies",
    links: [
      { label: "Help centre", href: "/help" },
      { label: "Terms of use (draft)", href: "/legal/terms" },
      { label: "Privacy notice (draft)", href: "/legal/privacy" },
      { label: "Research use (draft)", href: "/legal/research" },
    ],
  },
];

/** The site footer with the storefront's category links. */
export function ShopFooter() {
  return <SiteFooter groups={GROUPS} />;
}
