import { Zap } from "lucide-react";
import { type ComponentPropsWithRef, type ReactNode, useId } from "react";
import { Heading, type HeadingLevel } from "../../atoms/Heading";
import { Icon } from "../../atoms/Icon";
import { Price } from "../../atoms/Price";
import type { ProductArtMotif } from "../../atoms/ProductArt";
import { ProductPicture } from "../../atoms/ProductPicture";
import { cn } from "../../lib/cn";
import type { StockState } from "../../molecules/StockBadge";

export type ProductCardProps = Omit<ComponentPropsWithRef<"article">, "children"> & {
  href: string;
  name: string;
  /** An optional one-line note in small grey under the name (a seller's tagline in previews, a status). Shop cards leave it out. */
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
  /** The usual price, shown struck through with "Was" text for screen readers. Never invented; the current price turns green only when this is given. */
  referencePricePaise?: bigint;
  storeName: string;
  stock?: StockState;
  zapEligible?: boolean;
  /** Semantic level of the product name; pick the level below the surrounding heading. */
  headingLevel?: HeadingLevel;
  /**
   * The control under the picture, e.g. an "Add to cart" pill. It sits above the card's stretched
   * link, so it stays clickable and keyboard reachable on its own.
   */
  actions?: ReactNode;
  /** Room for a rating summary under the name. Nothing is drawn when absent; there is no rating data yet. */
  rating?: ReactNode;
  /** A small control on the picture's top-right corner, e.g. the save heart. Same stacking as `actions`. */
  overlay?: ReactNode;
};

/** The words of the tag on the picture: a state the data has, or nothing. Zap eligibility is the fallback. */
function tagOf(stock: StockState | undefined, zapEligible: boolean): ReactNode {
  if (stock?.state === "sold-out") return "Sold out";
  if (stock?.state === "low") return `Only ${stock.count} left`;
  if (stock?.state === "edition") return `Edition #${stock.number} of ${stock.of}`;
  if (zapEligible) {
    return (
      <>
        <Icon icon={Zap} size={12} />
        Zap
      </>
    );
  }
  return null;
}

/**
 * A flat product card in the order shoppers scan it: the picture with a small dark tag at its
 * top-left (a real state only: sold out, low stock, an edition number, or Zap) and an optional
 * control at its top-right, then the action pill, the bold price, the name over two lines and the
 * seller in small grey. The whole card is one link named after the product.
 */
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
  headingLevel = 3,
  actions,
  overlay,
  rating,
  className,
  ...props
}: ProductCardProps) {
  const uid = useId();
  const nameId = `${uid}-name`;
  const priceId = `${uid}-price`;
  const sellerId = `${uid}-seller`;
  const tag = tagOf(stock, zapEligible);
  const reduced = referencePricePaise !== undefined;
  return (
    <article
      className={cn(
        "group relative flex h-full flex-col gap-2 rounded-lg focus-within:outline focus-within:outline-2 focus-within:outline-offset-4 focus-within:outline-focus",
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
          className="rounded-lg transition-opacity duration-fast group-hover:opacity-90"
        />
        {tag ? (
          <p className="pointer-events-none absolute top-2 left-2 inline-flex items-center gap-1 rounded-sm bg-accent-soft px-2 py-1 font-body text-xs font-bold text-accent">
            {tag}
          </p>
        ) : null}
        {overlay ? <div className="absolute top-1 right-1 z-10">{overlay}</div> : null}
      </div>
      {actions ? <div className="relative z-10 flex flex-col items-start">{actions}</div> : null}
      <p id={priceId} className="flex flex-wrap items-baseline gap-x-2">
        <Price
          amountPaise={pricePaise}
          className={cn("text-xl font-bold", reduced ? "text-success" : "text-fg")}
        />
        {reduced ? (
          <span className="text-fg-muted">
            <span className="sr-only">Was </span>
            <Price
              amountPaise={referencePricePaise}
              className="text-sm font-normal text-fg-muted line-through"
            />
          </span>
        ) : null}
      </p>
      <Heading
        level={headingLevel}
        size="sm"
        id={nameId}
        className="line-clamp-2 min-h-12 text-base font-normal tracking-normal"
      >
        <a
          href={href}
          aria-labelledby={nameId}
          aria-describedby={`${priceId} ${sellerId}`}
          className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
        >
          {name}
        </a>
      </Heading>
      {hook ? <p className="line-clamp-1 text-sm text-fg-muted">{hook}</p> : null}
      {rating ? <div className="text-sm">{rating}</div> : null}
      <p id={sellerId} className="truncate text-sm text-fg-muted">
        <span className="sr-only">Sold by </span>
        {storeName}
      </p>
    </article>
  );
}
