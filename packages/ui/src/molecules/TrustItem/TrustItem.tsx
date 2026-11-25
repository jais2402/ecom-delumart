import type { LucideIcon } from "lucide-react";
import type { ComponentPropsWithRef } from "react";
import { Icon } from "../../atoms/Icon";
import { cn } from "../../lib/cn";

export type TrustItemProps = Omit<ComponentPropsWithRef<"div">, "title" | "children"> & {
  icon: LucideIcon;
  title: string;
  text: string;
};

/** An outline icon, a bold short title and one muted line. */
export function TrustItem({ icon, title, text, className, ...props }: TrustItemProps) {
  return (
    <div className={cn("flex items-start gap-3 font-body", className)} {...props}>
      <Icon icon={icon} size={28} strokeWidth={1.5} className="mt-0.5 shrink-0 text-action" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-base font-bold text-fg">{title}</span>
        <span className="text-sm text-fg-muted">{text}</span>
      </div>
    </div>
  );
}
