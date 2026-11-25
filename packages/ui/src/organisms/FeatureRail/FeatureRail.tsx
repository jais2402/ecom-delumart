import type { ComponentPropsWithRef } from "react";
import { Price } from "../../atoms/Price";
import type { ProductArtMotif } from "../../atoms/ProductArt";
import { ProductPicture } from "../../atoms/ProductPicture";
import { cn } from "../../lib/cn";
import { SectionHeading } from "../../molecules/SectionHeading";

export type FeatureItem = {
  id: string;
  href: string;
  name: string;
  hook: string;
  /** Integer paise; shown with the money formatter. */
  pricePaise: bigint;
  hue: number;
  motif: ProductArtMotif;
  imageSrc?: string | undefined;
};

export type FeatureRailProps = Omit<ComponentPropsWithRef<"section">, "title" | "children"> & {
  title: string;
  lead?: string;
  items: readonly FeatureItem[];
};

/** A few large picture cards with the name, one line and the price laid over a dark scrim at the bottom. Each card is one link. */
export function FeatureRail({ title, lead, items, id = "featured", className, ...props }: FeatureRailProps) {
  const headingId = `${id}-title`;
  if (items.length === 0) return null;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cn("flex flex-col gap-6 rounded-lg bg-surface p-5 md:p-6", className)}
      {...props}
    >
      <SectionHeading title={title} {...(lead ? { lead } : {})} headingId={headingId} />
      <ul className="grid gap-4 md:grid-cols-3">
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={item.href}
              className="group relative isolate flex aspect-[4/5] flex-col justify-end overflow-hidden rounded-lg bg-ink text-fg-on-ink"
            >
              <ProductPicture
                imageSrc={item.imageSrc}
                alt=""
                hue={item.hue}
                seed={item.name}
                motif={item.motif}
                className="absolute inset-0 -z-20 aspect-auto size-full rounded-none transition-transform duration-base group-hover:scale-[1.02]"
              />
              <span
                aria-hidden="true"
                className="absolute inset-0 -z-10 bg-gradient-to-t from-ink/90 via-ink/40 to-transparent"
              />
              <span className="flex flex-col gap-1 p-5">
                <span className="text-xl font-bold">{item.name}</span>
                <span className="line-clamp-1 text-sm text-fg-on-ink-muted">{item.hook}</span>
                <span className="mt-1 text-sm">
                  From <Price amountPaise={item.pricePaise} className="text-base font-bold text-fg-on-ink" />
                </span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
