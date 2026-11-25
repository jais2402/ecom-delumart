import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn } from "../../lib/cn";

export type HomeLayoutProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  /** The row of category pictures under the header. */
  categories: ReactNode;
  hero: ReactNode;
  /** A featured rail of large picture cards. */
  featured: ReactNode;
  /** The two half-width banners under the hero. */
  promos: ReactNode;
  /** The product rails, in order. */
  children: ReactNode;
  trust: ReactNode;
  steps: ReactNode;
  creator: ReactNode;
};

/** The storefront home page's vertical rhythm. Slots only; no content of its own. */
export function HomeLayout({
  categories,
  hero,
  featured,
  promos,
  children,
  trust,
  steps,
  creator,
  className,
  ...props
}: HomeLayoutProps) {
  return (
    <div className={cn("flex flex-col gap-12", className)} {...props}>
      {categories}
      {hero}
      {featured}
      <div className="grid gap-6 md:grid-cols-2">{promos}</div>
      {children}
      {trust}
      {steps}
      {creator}
    </div>
  );
}
