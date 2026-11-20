import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn } from "../../lib/cn";

export type ShopLayoutProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  header: ReactNode;
  footer: ReactNode;
  children: ReactNode;
};

/** Header, main and footer slots with a skip-to-content link. No content of its own. */
export function ShopLayout({ header, footer, children, className, ...props }: ShopLayoutProps) {
  return (
    <div className={cn("flex min-h-screen flex-col bg-bg text-fg", className)} {...props}>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:inline-flex focus:min-h-touch focus:items-center focus:rounded-md focus:bg-action focus:px-4 focus:text-fg-on-action"
      >
        Skip to content
      </a>
      {header}
      <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-content flex-1 px-4 py-6">
        {children}
      </main>
      {footer}
    </div>
  );
}
