import { Store, Truck, Zap } from "lucide-react";
import { type ComponentPropsWithRef, type ReactNode, useId } from "react";
import { Badge } from "../../atoms/Badge";
import { Heading, type HeadingLevel } from "../../atoms/Heading";
import { Icon } from "../../atoms/Icon";
import { Price } from "../../atoms/Price";
import type { ProductArtMotif } from "../../atoms/ProductArt";
import { ProductPicture } from "../../atoms/ProductPicture";
import { cn } from "../../lib/cn";
import { StockBadge, type StockState } from "../../molecules/StockBadge";

export type ProductCardProps = Omit<ComponentPropsWithRef<"article">, "children"> & {
  href: string;
  name: string;
  /** The product's one-line joke, shown in small grey under the name. */
  hook?: string;
  hue: number;
  /** Seed for the generated art; defaults to the name. */
  artSeed?: string;
  /** Which object the generated art draws; normally from the product's category. */
  motif?: ProductArtMotif;
  /** A photo from our own origin. When absent the generated art is drawn. */
  imageSrc?: string | undefined;
  /** Description of the imagined product photo. */
  imageAlt?: string;
  pricePaise: bigint;
  /** The usual price, shown struck through with "Was" text for screen readers,. Never invented. */
  referencePricePaise?: bigint;
  storeName: string;
  stock?: StockState;
  zapEligible?: boolean;
  /** A short delivery line under the actions, such as "Delivery in about 24 hours". Hidden when absent. */
  deliveryNote?: string;
  /** The extra line for Zap-eligible products, such as "Zap in 10 min". */
  zapNote?: string;
  /** Semantic level of the product name; pick the level below the surrounding heading. */
  headingLevel?: HeadingLevel;
  /**
   * Controls shown under the price, e.g. an "Add to cart" button. They sit above the card's
   * stretched link, so they stay clickable and keyboard reachable on their own.
   */
  actions?: ReactNode;
};

/** Flat product card, no box: picture on a light tile, name, seller, price, actions, a quiet delivery line. The whole card is one link named after the product. */
export function ProductCard({
  href,
  name,
  hook,
  hue,
  artSeed,
  motif,
  imageSrc,
  imageAlt,
  pricePaise,
  referencePricePaise,
  storeName,
  stock,
  zapEligible = false,
  deliveryNote,
  zapNote,
  headingLevel = 3,
  actions,
  className,
  ...props
}: ProductCardProps) {
  const uid = useId();
  const nameId = `${uid}-name`;
  const infoId = `${uid}-info`;
  const showStock = stock !== undefined && stock.state !== "in-stock";
  return (
    <article
      className={cn(
        "group relative flex h-full flex-col gap-2 rounded-md focus-within:outline focus-within:outline-2 focus-within:outline-offset-4 focus-within:outline-focus",
        className,
      )}
      {...props}
    >
      <div className="relative">
        <ProductPicture
          imageSrc={imageSrc}
          hue={hue}
          seed={artSeed ?? name}
          alt={imageAlt ?? ""}
          motif={motif}
          className="transition-opacity duration-fast group-hover:opacity-90"
        />
        {stock && showStock ? (
          <div className="pointer-events-none absolute top-2 left-2">
            <StockBadge {...stock} />
          </div>
        ) : null}
      </div>
      <Heading level={headingLevel} size="sm" id={nameId} className="mt-3 line-clamp-2 text-base font-normal">
        <a
          href={href}
          aria-labelledby={nameId}
          aria-describedby={infoId}
          className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
        >
          {name}
        </a>
      </Heading>
      {hook ? <p className="line-clamp-1 text-sm text-fg-muted">{hook}</p> : null}
      <p id={infoId} className="flex flex-col gap-1 text-sm">
        <span className="flex items-center gap-1 text-fg-muted">
          <Icon icon={Store} size={14} />
          <span className="sr-only">Sold by </span>
          <span className="min-w-0 truncate">{storeName}</span>
        </span>
        <span className="mt-1 flex flex-wrap items-baseline gap-x-2">
          <Price amountPaise={pricePaise} className="text-xl font-bold text-fg" />
          {referencePricePaise !== undefined ? (
            <span className="text-fg-muted">
              <span className="sr-only">Was </span>
              <Price
                amountPaise={referencePricePaise}
                className="text-sm font-normal text-fg-muted line-through"
              />
            </span>
          ) : null}
        </span>
      </p>
      {actions ? <div className="relative z-10 mt-1 flex items-center gap-2">{actions}</div> : null}
      {stock?.state === "in-stock" ? <p className="text-xs font-medium text-success">In stock</p> : null}
      {deliveryNote || (zapEligible && zapNote) ? (
        <p className="flex flex-col gap-0.5 text-xs text-fg-muted">
          {deliveryNote ? (
            <span className="flex items-center gap-1.5">
              <Icon icon={Truck} size={14} />
              <span>{deliveryNote}</span>
            </span>
          ) : null}
          {zapEligible && zapNote ? (
            <Badge tone="accent" className="self-start">
              <Icon icon={Zap} size={12} />
              {zapNote}
            </Badge>
          ) : null}
        </p>
      ) : null}
    </article>
  );
}
