import type { ComponentPropsWithRef } from "react";
import { Button } from "../../atoms/Button";
import { Heading } from "../../atoms/Heading";
import type { ProductArtMotif } from "../../atoms/ProductArt";
import { ProductPicture } from "../../atoms/ProductPicture";
import { cn } from "../../lib/cn";

export type HeroTile = {
  href: string;
  /** The caption's bold first line, usually a category name. */
  caption: string;
  /** A short second line. */
  detail?: string;
  hue: number;
  seed: string;
  motif: ProductArtMotif;
  /** A photo from our own origin; generated art is drawn when absent. */
  imageSrc?: string | undefined;
};
export type HeroAction = { label: string; href: string };

export type HomeHeroProps = Omit<ComponentPropsWithRef<"section">, "title" | "children"> & {
  /** The page's one h1. */
  title: string;
  /** One line of subcopy. */
  text: string;
  action: HeroAction;
  /** Up to three picture tiles beside the colour block; each links to a category. */
  tiles?: readonly HeroTile[];
};

function Tile({ tile, className, eager }: { tile: HeroTile; className?: string; eager?: boolean }) {
  return (
    <a
      href={tile.href}
      className={cn(
        "group relative isolate flex min-w-0 flex-col justify-end overflow-hidden rounded-lg bg-ink text-fg-on-ink",
        className,
      )}
    >
      <ProductPicture
        imageSrc={tile.imageSrc}
        alt=""
        hue={tile.hue}
        seed={tile.seed}
        motif={tile.motif}
        eager={eager}
        className="absolute inset-0 -z-20 aspect-auto size-full rounded-none transition-transform duration-base group-hover:scale-[1.02]"
      />
      <span
        aria-hidden="true"
        className="absolute inset-0 -z-10 bg-gradient-to-t from-ink/90 via-ink/40 to-transparent"
      />
      <span className="flex flex-col gap-0.5 p-4">
        <span className="text-lg font-bold">{tile.caption}</span>
        {tile.detail ? <span className="text-sm text-fg-on-ink-muted">{tile.detail}</span> : null}
      </span>
    </a>
  );
}

/** A mosaic: a large blue block with the headline, one line and one button, beside up to three picture tiles with captions on a dark scrim. */
export function HomeHero({ title, text, action, tiles = [], className, ...props }: HomeHeroProps) {
  const [first, second, third] = tiles;
  return (
    <section className={cn("grid gap-4 lg:h-[24rem] lg:grid-cols-12", className)} {...props}>
      <div className="flex flex-col items-start justify-between gap-8 rounded-lg bg-band p-8 text-fg-on-band md:p-10 lg:col-span-6">
        <Heading level={1} size="xl" className="text-4xl leading-tight text-fg-on-band md:text-5xl">
          {title}
        </Heading>
        <div className="flex flex-col items-start gap-5">
          <p className="max-w-md font-body text-base text-fg-on-band-muted md:text-lg">{text}</p>
          <Button
            asChild
            size="lg"
            className="bg-cta text-fg-on-cta hover:bg-cta-hover focus-visible:outline-fg-on-band"
          >
            <a href={action.href}>{action.label}</a>
          </Button>
        </div>
      </div>
      {first ? <Tile tile={first} eager className="aspect-square lg:col-span-3 lg:aspect-auto" /> : null}
      {second || third ? (
        <div className="grid grid-cols-2 gap-4 lg:col-span-3 lg:grid-cols-1 lg:grid-rows-2">
          {second ? <Tile tile={second} eager className="aspect-square lg:aspect-auto" /> : null}
          {third ? <Tile tile={third} eager className="aspect-square lg:aspect-auto" /> : null}
        </div>
      ) : null}
    </section>
  );
}
