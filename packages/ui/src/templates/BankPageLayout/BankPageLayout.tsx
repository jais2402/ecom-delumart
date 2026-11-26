import type { ComponentPropsWithRef, ReactNode } from "react";
import { FictionLabel } from "../../atoms/FictionLabel";
import { cn } from "../../lib/cn";

export type BankPageLayoutProps = Omit<ComponentPropsWithRef<"main">, "children"> & {
  children: ReactNode;
};

/** A narrow white panel under an indigo band for the mock bank step, always labelled as in-game. */
export function BankPageLayout({ children, className, ...props }: BankPageLayoutProps) {
  return (
    <div className="flex min-h-screen flex-col bg-bg text-fg">
      <header className="bg-band px-4 py-3 text-center font-display text-xl font-bold text-fg-on-band">
        Delulu Bank
      </header>
      <div className="flex flex-1 flex-col items-center gap-4 px-4 py-8">
        <FictionLabel className="text-center">In-game bank page · fictional money</FictionLabel>
        <main id="main-content" className={cn("w-full max-w-md", className)} {...props}>
          {children}
        </main>
      </div>
    </div>
  );
}
