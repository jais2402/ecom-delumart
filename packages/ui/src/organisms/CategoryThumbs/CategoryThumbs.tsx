import type { ComponentPropsWithRef } from "react";
import { Heading } from "../../atoms/Heading";
import { cn } from "../../lib/cn";
import { type CategoryLink, CategoryThumb } from "../../molecules/CategoryThumb";

export type CategoryThumbItem = CategoryLink & {
  hue: number;
  seed: string;
  imageSrc?: string | undefined;
};

export type CategoryThumbsProps = Omit<ComponentPropsWithRef<"nav">, "children"> & {
  categories: readonly CategoryThumbItem[];
  /** The small centred heading; it also names the navigation. */
  title?: string;
};

/** A centred "Shop by category" heading over a row of small category pictures with their names beneath; the row scrolls sideways inside itself on narrow screens. Its id is the target of the tab bar's Categories tab. */
export function CategoryThumbs({
  categories,
  title = "Shop by category",
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
      <Heading level={2} size="md" id={headingId} className="text-center text-xl">
        {title}
      </Heading>
      <ul className="-mx-4 flex gap-4 overflow-x-auto px-4 pb-1 md:-mx-5 md:justify-center md:gap-6 md:px-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {categories.map(({ slug, ...thumb }) => (
          <li key={slug} className="w-24 shrink-0 md:w-28">
            <CategoryThumb {...thumb} />
          </li>
        ))}
      </ul>
    </nav>
  );
}
