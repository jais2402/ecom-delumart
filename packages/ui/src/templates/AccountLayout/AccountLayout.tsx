import type { ReactNode } from "react";
import { ShopLayout, type ShopLayoutProps } from "../ShopLayout";

export type AccountLayoutProps = ShopLayoutProps & {
  sidebar: ReactNode;
};

/**
 * Shop layout with a sidebar slot: a white navigation panel on the left from 768px, and above the
 * content on small screens (where a responsive SidebarNav turns into a row of pills that scrolls).
 */
export function AccountLayout({ sidebar, children, ...props }: AccountLayoutProps) {
  return (
    <ShopLayout {...props}>
      <div className="grid gap-4 md:grid-cols-[15rem_minmax(0,1fr)] md:items-start md:gap-6">
        <aside aria-label="Account sections" className="min-w-0 md:rounded-lg md:bg-surface md:p-2">
          {sidebar}
        </aside>
        <div className="min-w-0 rounded-lg bg-surface p-4 md:p-6">{children}</div>
      </div>
    </ShopLayout>
  );
}
