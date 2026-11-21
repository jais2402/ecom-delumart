import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn } from "../../lib/cn";

export type OnboardingLayoutProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  /** Persistent notice above everything else, e.g. a demo-mode banner. */
  banner?: ReactNode;
  progress: ReactNode;
  children: ReactNode;
  homeHref?: string;
};

/** Centred narrow column: logo, progress, one main region and the fictional-money footer line. */
export function OnboardingLayout({
  banner,
  progress,
  children,
  homeHref = "/",
  className,
  ...props
}: OnboardingLayoutProps) {
  return (
    <div className={cn("flex min-h-screen flex-col bg-bg text-fg", className)} {...props}>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:inline-flex focus:min-h-touch focus:items-center focus:rounded-md focus:bg-action focus:px-4 focus:text-fg-on-action"
      >
        Skip to content
      </a>
      {banner ? <div className="border-b border-border bg-surface px-4 py-2">{banner}</div> : null}
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-6">
        <header className="self-start">
          <a
            href={homeHref}
            className="inline-flex min-h-touch items-center font-display text-2xl font-bold text-action"
          >
            DeluluMart
          </a>
        </header>
        {progress}
        <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 outline-none">
          {children}
        </main>
        <footer className="border-t border-border pt-4 font-body text-sm text-fg-muted">
          Fictional money only. No real cards, no real payments. Nothing real ships.
        </footer>
      </div>
    </div>
  );
}
