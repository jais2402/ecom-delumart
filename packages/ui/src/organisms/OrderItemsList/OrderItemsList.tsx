import type { ComponentPropsWithRef, ReactNode } from "react";
import { Heading } from "../../atoms/Heading";
import { ProductPicture } from "../../atoms/ProductPicture";
import { cn } from "../../lib/cn";

export type OrderItem = {
  id: string;
  name: string;
  /** Base hue of the generated art, used when there is no photo. */
  hue: number;
  /** A photo from our own origin; generated art is drawn when absent. */
  imageSrc?: string | undefined;
  /** A small muted line under the name, e.g. "Sold by Cloud Nine". */
  note?: string;
};

export type OrderItemsListProps = Omit<ComponentPropsWithRef<"section">, "children" | "title"> & {
  /** Heading and accessible name, e.g. "Your items". */
  title: string;
  items: readonly OrderItem[];
  /** Under the list, e.g. a link back to the cart. */
  footer?: ReactNode;
};

/** The things being bought, each with its photo: the top of a checkout summary. */
export function OrderItemsList({ title, items, footer, className, ...props }: OrderItemsListProps) {
  return (
    <section
      aria-label={title}
      className={cn("flex flex-col gap-3 rounded-lg bg-surface p-4 font-body", className)}
      {...props}
    >
      <Heading level={2} size="sm">
        {title}
      </Heading>
      <ul className="flex flex-col gap-3">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-3">
            <ProductPicture
              imageSrc={item.imageSrc}
              hue={item.hue}
              seed={item.name}
              alt=""
              className="size-14 shrink-0"
            />
            <div className="min-w-0">
              <p className="break-words text-base text-fg">{item.name}</p>
              {item.note ? <p className="break-words text-sm text-fg-muted">{item.note}</p> : null}
            </div>
          </li>
        ))}
      </ul>
      {footer}
    </section>
  );
}
