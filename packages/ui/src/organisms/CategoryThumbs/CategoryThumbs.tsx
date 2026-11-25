import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";
import { type CategoryLink, CategoryThumb } from "../../molecules/CategoryThumb";

export type CategoryThumbItem = CategoryLink & {
  hue: number;
  seed: string;
  imageSrc?: string | undefined;
};

export type CategoryThumbsProps = Omit<ComponentPropsWithRef<"nav">, "children"> & {
  categories: readonly CategoryThumbItem[];
};

/** A row of square category pictures with their names beneath; it scrolls sideways inside itself on narrow screens. Its id is the target of the tab bar's Categories tab. */
export function CategoryThumbs({ categories, id = "categories", className, ...props }: CategoryThumbsProps) {
  return (
    <nav
      id={id}
      aria-label="Shop by category"
      className={cn("scroll-mt-32 rounded-lg bg-surface p-5 md:p-6", className)}
      {...props}
    >
      <ul className="-mx-5 flex gap-4 overflow-x-auto px-5 pb-1 md:-mx-6 md:px-6 [scrollbar-width:none] md:gap-6 lg:justify-between [&::-webkit-scrollbar]:hidden">
        {categories.map(({ slug, ...thumb }) => (
          <li key={slug} className="w-28 shrink-0 md:w-36">
            <CategoryThumb {...thumb} />
          </li>
        ))}
      </ul>
    </nav>
  );
}
