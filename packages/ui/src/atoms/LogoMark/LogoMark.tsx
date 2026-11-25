import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";

export type LogoMarkProps = Omit<ComponentPropsWithRef<"svg">, "children"> & {
  /** "onBand" is for the solid brand band (white mark); "default" is amber with a blue sparkle, for light grounds. */
  tone?: "default" | "onBand";
};

/** The DeluluMart mark: a speech bubble with a sparkle in it. Decorative; the wordmark names the link. */
export function LogoMark({ tone = "default", className, ...props }: LogoMarkProps) {
  const onBand = tone === "onBand";
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
      className={cn("size-9 shrink-0", className)}
      {...props}
    >
      <path
        d="M6 2h20a6 6 0 0 1 6 6v13a6 6 0 0 1-6 6H15l-7 5v-5H6a6 6 0 0 1-6-6V8a6 6 0 0 1 6-6Z"
        className={onBand ? "fill-fg-on-band" : "fill-cta"}
      />
      <path d="M16 6Q16 16 26 16Q16 16 16 26Q16 16 6 16Q16 16 16 6Z" className="fill-band" />
    </svg>
  );
}
