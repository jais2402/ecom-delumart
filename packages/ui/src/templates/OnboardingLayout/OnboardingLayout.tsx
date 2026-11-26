import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn } from "../../lib/cn";

export type OnboardingLayoutProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  /** Persistent notice above everything else, e.g. a demo-mode banner. */
  banner?: ReactNode;
  progress: ReactNode;
  children: ReactNode;
  homeHref?: string;
};

/**
 * Indigo band with the logo, a light-grey page and one white panel: progress, the main region and
 * the fictional-money footer line.
 */
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
      <header className="bg-band text-fg-on-band">
        <div className="mx-auto flex w-full max-w-content items-center px-4 py-2">
          <a
            href={homeHref}
            className="inline-flex min-h-touch items-center rounded-md font-display text-2xl font-bold text-fg-on-band focus-visible:outline-fg-on-band"
          >
            DeluluMart
          </a>
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-4 px-4 py-6 md:py-10">
        {banner}
        <div className="flex flex-col gap-6 rounded-lg bg-surface p-4 md:p-8">
          {progress}
          <main id="main-content" tabIndex={-1} className="min-w-0 outline-none">
            {children}
          </main>
        </div>
        <footer className="font-body text-sm text-fg-muted">
          Fictional money only. No real cards, no real payments. Nothing real ships.
        </footer>
      </div>
    </div>
  );
}
