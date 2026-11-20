import type { ReactNode } from "react";
import { OperatorShell } from "../OperatorShell";

export type ConsoleLayoutProps = {
  /** Sidebar navigation slot, usually a SidebarNav. */
  nav: ReactNode;
  /** Optional top bar content, such as the signed-in name. */
  topBar?: ReactNode;
  children: ReactNode;
  className?: string;
};

/** Operator layout labelled "Commerce Console". */
export function ConsoleLayout({ nav, topBar, children, className }: ConsoleLayoutProps) {
  return (
    <OperatorShell
      productLabel="Commerce Console"
      nav={nav}
      {...(topBar ? { topBar } : {})}
      {...(className ? { className } : {})}
    >
      {children}
    </OperatorShell>
  );
}
