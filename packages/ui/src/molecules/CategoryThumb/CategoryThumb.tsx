import type { ComponentPropsWithRef } from "react";
import type { ProductArtMotif } from "../../atoms/ProductArt";
import { ProductPicture } from "../../atoms/ProductPicture";
import { cn } from "../../lib/cn";

export type CategoryLink = {
  slug: string;
  name: string;
  href: string;
  motif: ProductArtMotif;
};

export type CategoryThumbProps = Omit<ComponentPropsWithRef<"a">, "children"> &
  Pick<CategoryLink, "name" | "motif"> & {
    hue: number;
    seed: string;
    /** One representative product photo, from our own origin. */
    imageSrc?: string | undefined;
  };

/** A square picture with the category's name beneath it, as one link. */
export function CategoryThumb({ name, motif, hue, seed, imageSrc, className, ...props }: CategoryThumbProps) {
  return (
    <a className={cn("group flex flex-col gap-2 font-body text-fg", className)} {...props}>
      <ProductPicture
        imageSrc={imageSrc}
        alt=""
        hue={hue}
        seed={seed}
        motif={motif}
        className="transition-opacity duration-fast group-hover:opacity-90"
      />
      <span className="text-sm font-semibold">{name}</span>
    </a>
  );
}
