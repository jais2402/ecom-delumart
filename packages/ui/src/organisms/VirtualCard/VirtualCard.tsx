import { Snowflake } from "lucide-react";
import type { ComponentPropsWithRef } from "react";
import { Badge } from "../../atoms/Badge";
import { Icon } from "../../atoms/Icon";
import { cn } from "../../lib/cn";
import { CardNumber } from "../../molecules/CardNumber";

export type VirtualCardProps = Omit<ComponentPropsWithRef<"section">, "children"> & {
  holderName: string;
  /** Fictional card number, displayed only. */
  number: string;
  frozen?: boolean;
  /** Friendly name used in the region label. */
  alias?: string;
};

export function VirtualCard({
  holderName,
  number,
  frozen = false,
  alias = "Virtual card",
  className,
  ...props
}: VirtualCardProps) {
  return (
    <section
      aria-label={`${alias}${frozen ? ", frozen" : ""}`}
      className={cn(
        "w-full max-w-sm overflow-hidden rounded-lg border border-border-strong bg-surface font-body shadow-raised",
        className,
      )}
      {...props}
    >
      <div className="flex items-center justify-between gap-2 bg-action px-4 py-3 text-fg-on-action">
        <p className="font-display text-lg font-bold">Delulu Bank</p>
        {frozen ? (
          <Badge tone="info">
            <Icon icon={Snowflake} size={12} />
            Frozen
          </Badge>
        ) : null}
      </div>
      <div className={cn("flex flex-col gap-3 p-4", frozen && "opacity-70")}>
        <CardNumber number={number} />
        <p className="text-base font-medium uppercase tracking-wide text-fg">{holderName}</p>
        <p className="text-xs font-bold tracking-wide text-fg-muted">VIRTUAL · DELULUMART ONLY</p>
      </div>
    </section>
  );
}
