import type { ReactNode } from "react";
import { OperatorShell } from "../OperatorShell";

export type PortalLayoutProps = {
  /** Sidebar navigation slot, usually a SidebarNav. */
  nav: ReactNode;
  /** Optional top bar content, such as the signed-in name. */
  topBar?: ReactNode;
  children: ReactNode;
  className?: string;
};

/** Operator layout labelled "Partner Portal". */
export function PortalLayout({ nav, topBar, children, className }: PortalLayoutProps) {
  return (
    <OperatorShell
      productLabel="Partner Portal"
      nav={nav}
      {...(topBar ? { topBar } : {})}
      {...(className ? { className } : {})}
    >
      {children}
    </OperatorShell>
  );
}
