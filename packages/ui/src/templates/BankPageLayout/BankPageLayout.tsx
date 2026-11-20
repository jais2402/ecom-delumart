import type { ComponentPropsWithRef, ReactNode } from "react";
import { FictionLabel } from "../../atoms/FictionLabel";
import { cn } from "../../lib/cn";

export type BankPageLayoutProps = Omit<ComponentPropsWithRef<"main">, "children"> & {
  children: ReactNode;
};

/** A narrow centred panel for the mock bank step, always labelled as in-game. */
export function BankPageLayout({ children, className, ...props }: BankPageLayoutProps) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-bg px-4 py-8 text-fg">
      <FictionLabel className="text-center">In-game bank page · fictional money</FictionLabel>
      <main id="main-content" className={cn("w-full max-w-md", className)} {...props}>
        {children}
      </main>
    </div>
  );
}
