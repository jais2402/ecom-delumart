import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export type OperatorShellProps = {
  /** Product label shown in the top bar, e.g. "Partner Portal". */
  productLabel: string;
  nav: ReactNode;
  topBar?: ReactNode;
  children: ReactNode;
  className?: string;
};

/** Shared by PortalLayout and ConsoleLayout; not exported from the package. */
export function OperatorShell({ productLabel, nav, topBar, children, className }: OperatorShellProps) {
  return (
    <div className={cn("flex min-h-screen flex-col bg-bg text-fg", className)}>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:inline-flex focus:min-h-touch focus:items-center focus:rounded-md focus:bg-action focus:px-4 focus:text-fg-on-action"
      >
        Skip to content
      </a>
      <header className="border-b border-border bg-surface">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
          <p className="font-display text-lg font-bold text-fg">
            <span className="text-action">DeluluMart</span> {productLabel}
          </p>
          {topBar ? <div className="ml-auto flex flex-wrap items-center gap-2">{topBar}</div> : null}
        </div>
      </header>
      <div className="grid flex-1 md:grid-cols-[14rem_minmax(0,1fr)]">
        <aside
          aria-label={`${productLabel} sections`}
          className="border-b border-border bg-surface p-3 md:border-r md:border-b-0"
        >
          {nav}
        </aside>
        <main id="main-content" tabIndex={-1} className="min-w-0 p-4">
          {children}
        </main>
      </div>
    </div>
  );
}
