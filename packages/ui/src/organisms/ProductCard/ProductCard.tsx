import { Zap } from "lucide-react";
import { type ComponentPropsWithRef, type ReactNode, useId } from "react";
import { Badge } from "../../atoms/Badge";
import { Heading, type HeadingLevel } from "../../atoms/Heading";
import { Icon } from "../../atoms/Icon";
import { Price } from "../../atoms/Price";
import { ProductArt } from "../../atoms/ProductArt";
import { cn } from "../../lib/cn";
import { StockBadge, type StockState } from "../../molecules/StockBadge";

export type ProductCardProps = Omit<ComponentPropsWithRef<"article">, "children"> & {
  href: string;
  name: string;
  hook: string;
  hue: number;
  /** Seed for the generated art; defaults to the name. */
  artSeed?: string;
  /** Description of the imagined product photo. */
  imageAlt?: string;
  pricePaise: bigint;
  /** The usual price, shown struck through with "Was" text for screen readers. Never invented. */
  referencePricePaise?: bigint;
  storeName: string;
  stock?: StockState;
  zapEligible?: boolean;
  /** Semantic level of the product name; pick the level below the surrounding heading. */
  headingLevel?: HeadingLevel;
  /**
   * Controls shown under the price, e.g. an "Add to cart" button. They sit above the card's
   * stretched link, so they stay clickable and keyboard reachable on their own.
   */
  actions?: ReactNode;
};

/** The whole card is one link named after the product; price and store are its description. */
export function ProductCard({
  href,
  name,
  hook,
  hue,
  artSeed,
  imageAlt,
  pricePaise,
  referencePricePaise,
  storeName,
  stock,
  zapEligible = false,
  headingLevel = 3,
  actions,
  className,
  ...props
}: ProductCardProps) {
  const uid = useId();
  const nameId = `${uid}-name`;
  const infoId = `${uid}-info`;
  return (
    <article
      className={cn(
        "relative flex h-full flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-raised focus-within:outline focus-within:outline-2 focus-within:outline-focus hover:border-border-strong",
        className,
      )}
      {...props}
    >
      <ProductArt hue={hue} seed={artSeed ?? name} alt={imageAlt ?? ""} className="rounded-none" />
      <div className="flex flex-1 flex-col gap-2 p-3 font-body">
        <Heading level={headingLevel} size="sm" id={nameId} className="text-lg">
          <a
            href={href}
            aria-labelledby={nameId}
            aria-describedby={infoId}
            className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
          >
            {name}
          </a>
        </Heading>
        <p className="text-sm text-fg-muted">{hook}</p>
        <div className="mt-auto flex flex-wrap items-center gap-2">
          {stock ? <StockBadge {...stock} /> : null}
          {zapEligible ? (
            <Badge tone="highlight">
              <Icon icon={Zap} size={12} />
              Zap in 10 min
            </Badge>
          ) : null}
        </div>
        <p id={infoId} className="flex flex-wrap items-baseline justify-between gap-x-2 text-sm">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <Price amountPaise={pricePaise} className="text-lg" />
            {referencePricePaise !== undefined ? (
              <span className="text-fg-muted">
                <span className="sr-only">Was </span>
                <Price amountPaise={referencePricePaise} className="font-normal text-fg-muted line-through" />
              </span>
            ) : null}
          </span>
          <span className="text-fg-muted">
            <span className="sr-only">Sold by </span>
            {storeName}
          </span>
        </p>
        {actions ? <div className="relative z-10 flex flex-col gap-2">{actions}</div> : null}
      </div>
    </article>
  );
}
