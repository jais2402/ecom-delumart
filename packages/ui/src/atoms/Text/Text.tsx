import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";

export type TextSize = "xs" | "sm" | "base" | "lg";
const sizeClasses: Record<TextSize, string> = { xs: "text-xs", sm: "text-sm", base: "text-base", lg: "text-lg" };

export type TextProps = ComponentPropsWithRef<"p"> & {
  size?: TextSize;
  muted?: boolean;
  /** Element to render; defaults to a paragraph. */
  as?: "p" | "span" | "div";
};

export function Text({ as: Tag = "p", size = "base", muted = false, className, ...props }: TextProps) {
  return (
    <Tag
      className={cn("font-body", sizeClasses[size], muted ? "text-fg-muted" : "text-fg", className)}
      {...props}
    />
  );
}
