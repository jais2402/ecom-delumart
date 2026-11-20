import type { ReactNode } from "react";
import { ShopLayout, type ShopLayoutProps } from "../ShopLayout";

export type CheckoutLayoutProps = ShopLayoutProps & {
  steps: ReactNode;
  summary: ReactNode;
};

/** Steps on top, then the step content and an order summary that stacks below on mobile. */
export function CheckoutLayout({ steps, summary, children, ...props }: CheckoutLayoutProps) {
  return (
    <ShopLayout {...props}>
      <div className="flex flex-col gap-6">
        <div>{steps}</div>
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0">{children}</div>
          <aside aria-label="Your order" className="min-w-0">
            {summary}
          </aside>
        </div>
      </div>
    </ShopLayout>
  );
}
