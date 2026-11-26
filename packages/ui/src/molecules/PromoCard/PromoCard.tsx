import type { ComponentPropsWithRef } from "react";
import { Heading, type HeadingLevel } from "../../atoms/Heading";
import type { ProductArtMotif } from "../../atoms/ProductArt";
import { ProductPicture } from "../../atoms/ProductPicture";
import { cn } from "../../lib/cn";

export type PromoCardItem = {
  id: string;
  href: string;
  /** A small line above the headline, such as a category name. */
  eyebrow: string;
  /** The bold headline; shown over at most three lines. */
  headline: string;
  /** Text of the underlined link, such as "Shop now". */
  linkLabel: string;
  /** "brand" is the indigo band colour, "warm" is amber with dark text. */
  tone?: "brand" | "warm";
  hue: number;
  motif: ProductArtMotif;
  /** A photo from our own origin; generated art is drawn when absent. */
  imageSrc?: string | undefined;
};

export type PromoCardProps = Omit<ComponentPropsWithRef<"article">, "children"> & {
  item: PromoCardItem;
  headingLevel?: HeadingLevel;
  /** Load the picture at once; for the first card. */
  eager?: boolean;
};

/**
 * A tall promo card: eyebrow, bold headline, an underlined link, and a picture at the bottom. The
 * link is named "<label>: <headline>". `relative` keeps screen-reader-only text inside the card, so
 * it cannot widen the page when the card sits in a clipped scroller.
 */
export function PromoCard({ item, headingLevel = 2, eager = false, className, ...props }: PromoCardProps) {
  const warm = item.tone === "warm";
  return (
    <article
      className={cn(
        "relative flex h-full min-w-0 flex-col gap-1 overflow-hidden rounded-lg p-5 md:p-6",
        warm ? "bg-cta text-fg-on-cta" : "bg-band text-fg-on-band",
        className,
      )}
      {...props}
    >
      <p className="font-body text-sm font-semibold">{item.eyebrow}</p>
      <Heading
        level={headingLevel}
        size="lg"
        className="line-clamp-3 text-2xl leading-tight text-current md:text-3xl"
      >
        {item.headline}
      </Heading>
      <a
        href={item.href}
        className={cn(
          "mt-1 inline-flex min-h-touch items-center self-start font-body text-sm font-semibold underline underline-offset-2",
          warm ? "focus-visible:outline-fg-on-cta" : "focus-visible:outline-fg-on-band",
        )}
      >
        {item.linkLabel}
        <span className="sr-only">: {item.headline}</span>
      </a>
      <div className="mt-auto pt-3">
        <ProductPicture
          imageSrc={item.imageSrc}
          alt=""
          hue={item.hue}
          seed={item.headline}
          motif={item.motif}
          eager={eager}
          className="aspect-square w-full rounded-lg"
        />
      </div>
    </article>
  );
}
