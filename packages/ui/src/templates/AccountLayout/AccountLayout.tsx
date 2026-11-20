import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { ShopLayout, type ShopLayoutProps } from "../ShopLayout";

export type AccountLayoutProps = ShopLayoutProps & {
  sidebar: ReactNode;
};

/** Shop layout with a sidebar slot; the sidebar stacks above the content on small screens. */
export function AccountLayout({ sidebar, children, ...props }: AccountLayoutProps) {
  return (
    <ShopLayout {...props}>
      <div className={cn("grid gap-6 md:grid-cols-[14rem_minmax(0,1fr)]")}>
        <aside aria-label="Account sections">{sidebar}</aside>
        <div className="min-w-0">{children}</div>
      </div>
    </ShopLayout>
  );
}
