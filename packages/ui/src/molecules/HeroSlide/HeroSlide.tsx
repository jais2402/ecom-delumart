import type { ComponentPropsWithRef } from "react";
import { Button } from "../../atoms/Button";
import { Heading } from "../../atoms/Heading";
import { Price } from "../../atoms/Price";
import type { ProductArtMotif } from "../../atoms/ProductArt";
import { ProductPicture } from "../../atoms/ProductPicture";
import { cn } from "../../lib/cn";

export type HeroSlideItem = {
  id: string;
  /** Where "Shop now" goes: the product's page. */
  href: string;
  name: string;
  /** The product's one-line hook. */
  hook: string;
  /** Integer paise; shown with the money formatter. */
  pricePaise: bigint;
  hue: number;
  motif: ProductArtMotif;
  /** A photo from our own origin; generated art is drawn when absent. */
  imageSrc?: string | undefined;
};

export type HeroSlideProps = Omit<ComponentPropsWithRef<"article">, "children"> & {
  item: HeroSlideItem;
  /** Load the photo at once; for the slide in view first. */
  eager?: boolean;
};

/**
 * One product-led hero panel: the name, its hook, the price and a "Shop now" button on the band
 * colour, beside the product's photo. The photo is shown at about its own size (a square), never
 * stretched across the whole panel, so it stays sharp. `relative` keeps the screen-reader-only
 * text inside the slide: without it that text escapes the carousel's clipping and widens the page.
 */
export function HeroSlide({ item, eager = false, className, ...props }: HeroSlideProps) {
  return (
    <article
      className={cn(
        "relative flex w-full min-w-0 flex-col overflow-hidden rounded-lg bg-band text-fg-on-band md:h-[26rem] md:flex-row-reverse",
        className,
      )}
      {...props}
    >
      <ProductPicture
        imageSrc={item.imageSrc}
        alt=""
        hue={item.hue}
        seed={item.name}
        motif={item.motif}
        eager={eager}
        className="aspect-[4/3] w-full shrink-0 rounded-none md:aspect-square md:h-full md:w-auto"
      />
      <div className="flex min-w-0 flex-1 flex-col items-start justify-center gap-3 p-6 md:p-12">
        <Heading
          level={2}
          size="xl"
          className="text-3xl leading-tight text-fg-on-band md:text-4xl lg:text-5xl"
        >
          {item.name}
        </Heading>
        <p className="line-clamp-2 max-w-xl font-body text-base text-fg-on-band-muted md:text-lg">
          {item.hook}
        </p>
        <p className="font-body text-sm text-fg-on-band-muted">
          <Price amountPaise={item.pricePaise} className="text-3xl font-bold text-fg-on-band" />
        </p>
        <Button asChild size="lg" variant="cta" className="mt-1 focus-visible:outline-fg-on-band">
          <a href={item.href}>
            Shop now
            <span className="sr-only">: {item.name}</span>
          </a>
        </Button>
      </div>
    </article>
  );
}
