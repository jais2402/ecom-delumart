import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn } from "../../lib/cn";

export type HomeLayoutProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  /** The row of tall promo cards. */
  hero: ReactNode;
  /** The compact promise row after the product rails. */
  promises: ReactNode;
  /** The "Shop by department" row of pictures. */
  categories: ReactNode;
  /** The product rails, in order. */
  children: ReactNode;
  /** The two half-width banners after the rails. */
  promos: ReactNode;
  /** The brand story panel. */
  story: ReactNode;
  steps: ReactNode;
  creator: ReactNode;
};

/** The storefront home page's vertical rhythm. Slots only; no content of its own. */
export function HomeLayout({
  hero,
  promises,
  categories,
  children,
  promos,
  story,
  steps,
  creator,
  className,
  ...props
}: HomeLayoutProps) {
  return (
    <div className={cn("flex flex-col gap-6 md:gap-8", className)} {...props}>
      {hero}
      {categories}
      {children}
      {promises}
      <div className="grid gap-4 md:grid-cols-2 md:gap-6">{promos}</div>
      {story}
      {steps}
      {creator}
    </div>
  );
}
