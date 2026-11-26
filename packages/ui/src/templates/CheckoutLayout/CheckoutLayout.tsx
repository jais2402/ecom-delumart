import type { ReactNode } from "react";
import { CollapsibleBlock } from "../../molecules/CollapsibleBlock";
import { ShopLayout, type ShopLayoutProps } from "../ShopLayout";

export type CheckoutLayoutProps = ShopLayoutProps & {
  steps: ReactNode;
  summary: ReactNode;
  /** Shown beside the summary toggle on phones, e.g. the total. */
  summaryHint?: ReactNode;
};

/**
 * Steps in a white panel on top; below, the step content on the left and the order summary on the
 * right from 1024px. On smaller screens the summary follows the content as a collapsible block.
 */
export function CheckoutLayout({ steps, summary, summaryHint, children, ...props }: CheckoutLayoutProps) {
  return (
    <ShopLayout {...props}>
      <div className="flex flex-col gap-4 md:gap-6">
        <div className="rounded-lg bg-surface p-4 md:px-6">{steps}</div>
        <div className="grid items-start gap-4 md:gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0">{children}</div>
          <aside aria-label="Your order" className="min-w-0">
            {summary ? (
              <CollapsibleBlock title="Order summary" {...(summaryHint ? { hint: summaryHint } : {})}>
                {summary}
              </CollapsibleBlock>
            ) : null}
          </aside>
        </div>
      </div>
    </ShopLayout>
  );
}
