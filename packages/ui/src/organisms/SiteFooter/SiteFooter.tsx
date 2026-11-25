import type { LucideIcon } from "lucide-react";
import { Lock, Truck, Wallet } from "lucide-react";
import type { ComponentPropsWithRef } from "react";
import { Icon } from "../../atoms/Icon";
import { LogoMark } from "../../atoms/LogoMark";
import { cn } from "../../lib/cn";

export type FooterLink = { label: string; href: string };
export type FooterGroup = { title: string; links: readonly FooterLink[] };
export type FooterPromise = { icon: LucideIcon; title: string; text: string };

export type SiteFooterProps = Omit<ComponentPropsWithRef<"footer">, "children"> & {
  /** Link columns. Every href must be a page that exists. */
  groups?: readonly FooterGroup[];
  /** Short promises in the dark band at the top. */
  promises?: readonly FooterPromise[];
  homeHref?: string;
};

const defaultGroups: readonly FooterGroup[] = [
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

const defaultPromises: readonly FooterPromise[] = [
  {
    icon: Truck,
    title: "Fast delivery",
    text: "Choose Standard, Express or Zap at checkout and follow your order to the door.",
  },
  {
    icon: Lock,
    title: "Secure checkout",
    text: "Every payment is confirmed with your PIN before it goes through.",
  },
  {
    icon: Wallet,
    title: "Independent shops",
    text: "Creators sell beside DeluluMart Originals, each with its own shop page.",
  },
];

const linkClass =
  "inline-flex min-h-touch items-center rounded-md text-sm text-fg-muted underline-offset-2 hover:text-fg hover:underline";

/**
 * A dark charcoal band of three promises, then a light section with the logo, link columns and the
 * fictional-money disclaimer in a thin bottom row.
 */
export function SiteFooter({
  groups = defaultGroups,
  promises = defaultPromises,
  homeHref = "/",
  className,
  ...props
}: SiteFooterProps) {
  return (
    <footer className={cn("font-body", className)} {...props}>
      <div className="bg-band text-fg-on-band">
        <ul className="mx-auto grid max-w-content gap-8 px-4 py-10 text-center md:grid-cols-3">
          {promises.map((promise) => (
            <li key={promise.title} className="flex flex-col items-center gap-2">
              <Icon icon={promise.icon} size={28} strokeWidth={1.5} />
              <p className="text-sm font-bold tracking-wide uppercase">{promise.title}</p>
              <p className="max-w-xs text-sm text-fg-on-band-muted">{promise.text}</p>
            </li>
          ))}
        </ul>
      </div>
      <div className="bg-surface text-fg">
        <div className="mx-auto grid max-w-content gap-8 px-4 py-10 md:grid-cols-[1.6fr_1fr_1fr_1fr]">
          <div className="flex max-w-sm flex-col gap-3">
            <a
              href={homeHref}
              className="inline-flex min-h-touch items-center gap-2 self-start rounded-md text-2xl font-bold"
            >
              <LogoMark />
              <span>DeluluMart</span>
            </a>
            <p className="text-sm text-fg-muted">
              A pretend department store for impossible objects. Everyone starts with ₹100 crore of game
              money.
            </p>
          </div>
          {groups.map((group) => (
            <nav key={group.title} aria-label={group.title}>
              <p className="mb-1 text-base font-bold">{group.title}</p>
              <ul className="flex flex-col">
                {group.links.map((link) => (
                  <li key={link.href + link.label}>
                    <a href={link.href} className={linkClass}>
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="border-t border-border">
          <p className="mx-auto max-w-content px-4 py-4 text-sm text-fg-muted">
            Fictional money only. Nothing real ships — delivery is simulated.
          </p>
        </div>
      </div>
    </footer>
  );
}
