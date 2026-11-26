import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ComponentPropsWithRef } from "react";
import { Icon } from "../../atoms/Icon";
import { cn } from "../../lib/cn";

export type CarouselControlsProps = Omit<ComponentPropsWithRef<"div">, "children" | "onSelect"> & {
  /** Number of slides. */
  count: number;
  /** Index of the slide in view, from 0. */
  index: number;
  /** Called with the index to show: a dot, or the previous or next slide (wrapping round). */
  onSelect: (index: number) => void;
  /** What the carousel holds, for the buttons' names: "Previous featured product". */
  noun?: string;
};

const arrow =
  "inline-flex min-h-touch min-w-touch items-center justify-center rounded-pill border border-border-strong bg-surface text-fg transition-colors duration-fast hover:bg-action-soft";

/** Previous and next buttons around a row of dots, for a carousel that only moves when asked. Every control is a 44px button with a name; the dot in view is marked with aria-current. */
export function CarouselControls({
  count,
  index,
  onSelect,
  noun = "slide",
  className,
  ...props
}: CarouselControlsProps) {
  if (count < 2) return null;
  return (
    <div className={cn("flex items-center justify-center gap-1", className)} {...props}>
      <button
        type="button"
        aria-label={`Previous ${noun}`}
        onClick={() => onSelect((index - 1 + count) % count)}
        className={arrow}
      >
        <Icon icon={ChevronLeft} />
      </button>
      <ol className="flex items-center">
        {Array.from({ length: count }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: dots are positions, they have no identity
          <li key={i}>
            <button
              type="button"
              aria-label={`Show ${noun} ${i + 1} of ${count}`}
              aria-current={i === index ? "true" : undefined}
              onClick={() => onSelect(i)}
              className="group inline-flex min-h-touch min-w-touch items-center justify-center rounded-pill"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "block h-2 rounded-pill transition-all duration-base motion-reduce:transition-none",
                  i === index ? "w-6 bg-action" : "w-2 bg-border-strong group-hover:bg-fg-muted",
                )}
              />
            </button>
          </li>
        ))}
      </ol>
      <button
        type="button"
        aria-label={`Next ${noun}`}
        onClick={() => onSelect((index + 1) % count)}
        className={arrow}
      >
        <Icon icon={ChevronRight} />
      </button>
    </div>
  );
}
