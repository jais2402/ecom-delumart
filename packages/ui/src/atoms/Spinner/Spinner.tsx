import { Loader2 } from "lucide-react";
import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";
import { VisuallyHidden } from "../VisuallyHidden";

export type SpinnerProps = ComponentPropsWithRef<"span"> & {
  label?: string;
};

export function Spinner({ label = "Loading", className, ...props }: SpinnerProps) {
  return (
    <span role="status" className={cn("inline-flex items-center text-action", className)} {...props}>
      <Loader2 aria-hidden="true" className="size-5 animate-spin motion-reduce:animate-none" />
      <VisuallyHidden>{label}</VisuallyHidden>
    </span>
  );
}
