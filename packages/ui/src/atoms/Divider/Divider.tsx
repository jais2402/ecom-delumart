import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";

export type DividerProps = Omit<ComponentPropsWithRef<"hr">, "children"> & {
  orientation?: "horizontal" | "vertical";
};

export function Divider({ orientation = "horizontal", className, ...props }: DividerProps) {
  return (
    <hr
      aria-orientation={orientation}
      className={cn(
        "border-0 bg-border",
        orientation === "horizontal" ? "h-px w-full" : "mx-2 inline-block h-full min-h-4 w-px self-stretch",
        className,
      )}
      {...props}
    />
  );
}
