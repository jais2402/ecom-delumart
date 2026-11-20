import { Zap } from "lucide-react";
import { type ComponentPropsWithRef, useId } from "react";
import { Badge } from "../../atoms/Badge";
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
  storeName: string;
  stock?: StockState;
  zapEligible?: boolean;
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
  storeName,
  stock,
  zapEligible = false,
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
        <h3 id={nameId} className="font-display text-lg font-bold text-fg">
          <a
            href={href}
            aria-labelledby={nameId}
            aria-describedby={infoId}
            className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
          >
            {name}
          </a>
        </h3>
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
          <Price amountPaise={pricePaise} className="text-lg" />
          <span className="text-fg-muted">
            <span className="sr-only">Sold by </span>
            {storeName}
          </span>
        </p>
      </div>
    </article>
  );
}
