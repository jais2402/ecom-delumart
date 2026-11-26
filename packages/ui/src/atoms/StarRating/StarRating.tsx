import { formatAverage, ratingLabel } from "@delulu/core";
import { Star } from "lucide-react";
import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";

export type StarRatingProps = Omit<ComponentPropsWithRef<"span">, "children" | "role"> & {
  /** The average times ten (43 is 4.3), as the API sends it; never a float. */
  averageTenths: number;
  /** How many reviews the average is of; names the image "4.3 out of 5 stars, 12 reviews". */
  count?: number;
  /** An accessible name of its own (e.g. "Rated 4 out of 5" for one review). */
  label?: string;
  size?: "sm" | "md";
};

const STARS = [1, 2, 3, 4, 5] as const;

/**
 * Five stars filled to the nearest whole star, as ONE image with a name that says the exact
 * average and the count (the stars themselves are decorative; colour is never the only signal).
 */
export function StarRating({
  averageTenths,
  count,
  label,
  size = "md",
  className,
  ...props
}: StarRatingProps) {
  const filled = Math.floor((Math.max(0, Math.min(50, averageTenths)) + 5) / 10);
  const name =
    label ??
    (count === undefined
      ? `${formatAverage(averageTenths)} out of 5 stars`
      : ratingLabel(averageTenths, count));
  const px = size === "sm" ? 14 : 18;
  return (
    <span
      role="img"
      aria-label={name}
      className={cn("inline-flex items-center gap-0.5", className)}
      {...props}
    >
      {STARS.map((n) => (
        <Star
          key={n}
          aria-hidden="true"
          size={px}
          data-filled={n <= filled ? "true" : "false"}
          className={n <= filled ? "fill-sun stroke-warning" : "fill-none stroke-fg-muted"}
        />
      ))}
    </span>
  );
}
