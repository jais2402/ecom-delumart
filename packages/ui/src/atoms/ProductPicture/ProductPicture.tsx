import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";
import { ProductArt, type ProductArtMotif } from "../ProductArt";

export type ProductPictureProps = Omit<ComponentPropsWithRef<"img">, "src" | "alt" | "width" | "height"> & {
  /** A photo served from our own origin. When absent, generated art is drawn instead. */
  imageSrc?: string | undefined;
  /** Describes the picture. Pass an empty string when it is purely decorative. */
  alt: string;
  /** Base hue of the generated art, used when there is no photo. */
  hue: number;
  /** Seed of the generated art, used when there is no photo. */
  seed: string;
  motif?: ProductArtMotif | undefined;
  /** Pixel size the photo was saved at (it is square); sets the image's intrinsic ratio so the page does not jump. */
  size?: number;
  /** Load at once instead of lazily; for pictures above the fold. */
  eager?: boolean;
};

/** A product's photo in a square tile, or the generated art when it has none. Plain `<img>`, never hot-linked. */
export function ProductPicture({
  imageSrc,
  alt,
  hue,
  seed,
  motif,
  size = 900,
  eager = false,
  className,
  ...props
}: ProductPictureProps) {
  if (!imageSrc) {
    return <ProductArt hue={hue} seed={seed} alt={alt} {...(motif ? { motif } : {})} className={className} />;
  }
  return (
    <img
      src={imageSrc}
      alt={alt}
      width={size}
      height={size}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      className={cn("block aspect-square w-full rounded-md bg-surface-raised object-cover", className)}
      {...props}
    />
  );
}
