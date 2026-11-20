import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";

export type FooterLink = { label: string; href: string };

export type SiteFooterProps = Omit<ComponentPropsWithRef<"footer">, "children"> & {
  links?: readonly FooterLink[];
};

const defaultLinks: readonly FooterLink[] = [
  { label: "About DeluluMart", href: "/about" },
  { label: "How the game works", href: "/how-it-works" },
  { label: "Sell on DeluluMart", href: "/sell" },
  { label: "Help", href: "/help" },
  { label: "Privacy", href: "/privacy" },
];

export function SiteFooter({ links = defaultLinks, className, ...props }: SiteFooterProps) {
  return (
    <footer className={cn("border-t border-border bg-surface font-body", className)} {...props}>
      <div className="mx-auto flex max-w-content flex-col gap-3 px-4 py-6">
        <nav aria-label="Footer">
          <ul className="flex flex-wrap gap-x-4">
            {links.map((link) => (
              <li key={link.href}>
                <a
                  href={link.href}
                  className="inline-flex min-h-touch items-center text-sm text-fg underline underline-offset-2 hover:text-action"
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <p className="text-sm text-fg-muted">Fictional money only. Nothing real ships — delivery is simulated.</p>
      </div>
    </footer>
  );
}
