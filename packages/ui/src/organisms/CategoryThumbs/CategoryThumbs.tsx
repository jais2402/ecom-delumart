import type { ComponentPropsWithRef } from "react";
import { Heading } from "../../atoms/Heading";
import { cn } from "../../lib/cn";
import { type CategoryLink, CategoryThumb } from "../../molecules/CategoryThumb";
import { ScrollRow } from "../../molecules/ScrollRow";

export type CategoryThumbItem = CategoryLink & {
  hue: number;
  seed: string;
  imageSrc?: string | undefined;
};

export type CategoryThumbsProps = Omit<ComponentPropsWithRef<"nav">, "children"> & {
  categories: readonly CategoryThumbItem[];
  /** The bold heading; it also names the navigation. */
  title?: string;
};

/** A "Shop by department" heading over a row of small pictures with bold names beneath, scrolling sideways with an arrow button. Its id is the target of the tab bar's Categories tab. */
export function CategoryThumbs({
  categories,
  title = "Shop by department",
  id = "categories",
  className,
  ...props
}: CategoryThumbsProps) {
  const headingId = `${id}-title`;
  return (
    <nav
      id={id}
      aria-labelledby={headingId}
      className={cn("flex scroll-mt-32 flex-col gap-4 rounded-lg bg-surface p-4 md:p-5", className)}
      {...props}
    >
      <Heading level={2} size="md" id={headingId} className="text-2xl md:text-3xl">
        {title}
      </Heading>
      <ScrollRow label={title} arrowClassName="top-1/3" listClassName="gap-4 md:gap-6">
        {categories.map(({ slug, ...thumb }) => (
          <li key={slug} className="relative w-24 shrink-0 md:w-28">
            <CategoryThumb {...thumb} />
          </li>
        ))}
      </ScrollRow>
    </nav>
  );
}
