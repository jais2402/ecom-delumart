import type { LucideIcon } from "lucide-react";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { Icon } from "../../atoms/Icon";
import { cn } from "../../lib/cn";

export type DeliveryRow = {
  icon: LucideIcon;
  text: ReactNode;
  /** A bold line under the text, such as the availability. */
  status?: string;
  /** "success" is for availability only. */
  statusTone?: "default" | "success";
};

export type DeliveryBoxProps = Omit<ComponentPropsWithRef<"ul">, "children"> & {
  rows: readonly DeliveryRow[];
};

/** One bordered box whose rows are separated by 1px lines: icon, plain text, bold status. */
export function DeliveryBox({ rows, className, ...props }: DeliveryBoxProps) {
  return (
    <ul
      className={cn("divide-y divide-border rounded-lg border border-border bg-surface font-body", className)}
      {...props}
    >
      {rows.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are a fixed short list
        <li key={index} className="flex items-start gap-4 p-4">
          <Icon icon={row.icon} size={28} strokeWidth={1.5} className="shrink-0 text-action" />
          <div className="flex min-w-0 flex-col gap-0.5 text-sm text-fg">
            <span>{row.text}</span>
            {row.status ? (
              <span className={cn("font-bold", row.statusTone === "success" ? "text-success" : "text-fg")}>
                {row.status}
              </span>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
