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

/** A small soft-square picture on a light tile with the category's name centred beneath it, as one link. */
export function CategoryThumb({ name, motif, hue, seed, imageSrc, className, ...props }: CategoryThumbProps) {
  return (
    <a
      className={cn("group flex flex-col items-center gap-2 rounded-lg font-body text-fg", className)}
      {...props}
    >
      <span className="block size-24 overflow-hidden rounded-xl bg-surface-raised md:size-28">
        <ProductPicture
          imageSrc={imageSrc}
          alt=""
          hue={hue}
          seed={seed}
          motif={motif}
          className="rounded-none transition-transform duration-base group-hover:scale-105"
        />
      </span>
      <span className="text-center text-sm font-semibold">{name}</span>
    </a>
  );
}
