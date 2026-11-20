import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";

export type HeadingLevel = 1 | 2 | 3 | 4;
export type HeadingSize = "xl" | "lg" | "md" | "sm";

const sizeClasses: Record<HeadingSize, string> = {
  xl: "text-4xl",
  lg: "text-3xl",
  md: "text-2xl",
  sm: "text-xl",
};
const defaultSize: Record<HeadingLevel, HeadingSize> = { 1: "xl", 2: "lg", 3: "md", 4: "sm" };

export type HeadingProps = ComponentPropsWithRef<"h2"> & {
  /** Semantic level (h1 to h4). */
  level?: HeadingLevel;
  /** Visual size, independent of the semantic level. */
  size?: HeadingSize;
};

export function Heading({ level = 2, size, className, ...props }: HeadingProps) {
  const Tag = `h${level}` as const;
  return (
    <Tag
      className={cn("font-display font-bold text-fg", sizeClasses[size ?? defaultSize[level]], className)}
      {...props}
    />
  );
}
