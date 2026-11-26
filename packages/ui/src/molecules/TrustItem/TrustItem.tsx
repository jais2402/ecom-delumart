import type { LucideIcon } from "lucide-react";
import type { ComponentPropsWithRef } from "react";
import { Icon } from "../../atoms/Icon";
import { cn } from "../../lib/cn";

export type TrustItemProps = Omit<ComponentPropsWithRef<"div">, "title" | "children"> & {
  icon: LucideIcon;
  title: string;
  text: string;
};

/** A compact promise: an outline icon, a bold short title and one muted line beneath it. */
export function TrustItem({ icon, title, text, className, ...props }: TrustItemProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-start gap-2 font-body sm:flex-row sm:items-center sm:gap-3",
        className,
      )}
      {...props}
    >
      <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-pill bg-action-soft text-action">
        <Icon icon={icon} size={22} strokeWidth={1.75} />
      </span>
      <div className="flex min-w-0 flex-col">
        <span className="text-sm font-bold text-fg">{title}</span>
        <span className="text-xs text-fg-muted">{text}</span>
      </div>
    </div>
  );
}
