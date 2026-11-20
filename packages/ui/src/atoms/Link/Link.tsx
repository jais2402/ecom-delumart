import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";

export type LinkProps = ComponentPropsWithRef<"a">;

export function Link({ className, ...props }: LinkProps) {
  return (
    <a
      className={cn(
        "inline-flex min-h-touch items-center font-medium text-action underline underline-offset-2 transition-colors duration-fast hover:text-action-hover",
        className,
      )}
      {...props}
    />
  );
}
