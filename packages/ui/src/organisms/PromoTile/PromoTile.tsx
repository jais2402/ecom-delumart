import type { ComponentPropsWithRef } from "react";
import { Button } from "../../atoms/Button";
import { Heading, type HeadingLevel } from "../../atoms/Heading";
import { ProductArt, type ProductArtMotif } from "../../atoms/ProductArt";
import { cn } from "../../lib/cn";

export type PromoTileProps = Omit<ComponentPropsWithRef<"article">, "title" | "children"> & {
  title: string;
  text: string;
  cta: { label: string; href: string };
  /** "brand" is the solid band blue; "warm" is amber with dark text. */
  tone?: "brand" | "warm";
  /** The product picture on the right. Decorative. */
  art: { hue: number; seed: string; motif: ProductArtMotif };
  headingLevel?: HeadingLevel;
};

/** A half-width banner: solid colour, a short headline, a button and a straight product picture. */
export function PromoTile({
  title,
  text,
  cta,
  tone = "warm",
  art,
  headingLevel = 2,
  className,
  ...props
}: PromoTileProps) {
  const brand = tone === "brand";
  return (
    <article
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-6 rounded-lg p-6 md:grid-cols-[minmax(0,1fr)_9rem] md:p-8",
        brand ? "bg-band text-fg-on-band" : "bg-cta text-fg-on-cta",
        className,
      )}
      {...props}
    >
      <div className="flex flex-col items-start gap-3">
        <Heading level={headingLevel} size="md" className="text-2xl text-current">
          {title}
        </Heading>
        <p className={cn("font-body text-sm", brand ? "text-fg-on-band-muted" : "text-fg-on-cta")}>{text}</p>
        <Button
          asChild
          className={cn(
            "mt-1",
            brand
              ? "bg-cta text-fg-on-cta hover:bg-cta-hover focus-visible:outline-fg-on-band"
              : "bg-ink text-fg-on-ink hover:bg-ink/90",
          )}
        >
          <a href={cta.href}>{cta.label}</a>
        </Button>
      </div>
      <ProductArt
        hue={art.hue}
        seed={art.seed}
        motif={art.motif}
        alt=""
        aria-hidden="true"
        className="rounded-md"
      />
    </article>
  );
}
