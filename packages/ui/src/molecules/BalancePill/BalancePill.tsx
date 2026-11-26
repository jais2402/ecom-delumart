import { Wallet } from "lucide-react";
import type { ComponentPropsWithRef } from "react";
import { FictionLabel } from "../../atoms/FictionLabel";
import { Icon } from "../../atoms/Icon";
import { Price } from "../../atoms/Price";
import { cn } from "../../lib/cn";

export type BalancePillProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  balancePaise: bigint;
  display?: "compact" | "exact";
  /** "band" is for the solid header band; "default" for ordinary surfaces. */
  tone?: "default" | "band";
  /** From 768px to 1439px show icon and amount only; the label stays in the accessible name. */
  condense?: boolean;
};

/** The wallet chip: the balance with its "fictional money" label always beside it. */
export function BalancePill({
  balancePaise,
  display = "compact",
  tone = "default",
  condense = false,
  className,
  ...props
}: BalancePillProps) {
  const onBand = tone === "band";
  return (
    <div
      className={cn(
        "inline-flex min-h-touch min-w-0 items-center gap-2 rounded-md border px-3 py-1 font-body text-sm",
        onBand ? "border-border-on-band text-fg-on-band" : "border-border bg-surface text-fg",
        className,
      )}
      {...props}
    >
      <Icon icon={Wallet} size={18} className="shrink-0" />
      <span className="flex min-w-0 flex-col leading-tight md:whitespace-nowrap">
        <Price
          amountPaise={balancePaise}
          display={display}
          className={cn("text-base font-bold", onBand ? "text-fg-on-band" : "text-fg")}
        />
        <span
          className={cn(
            "flex flex-wrap gap-x-1 text-xs",
            onBand ? "text-fg-on-band-muted" : "text-fg-muted",
            condense && "md:max-[1439px]:sr-only",
          )}
        >
          <span className="sr-only min-[480px]:not-sr-only">Balance</span>
          <FictionLabel
            className={cn("normal-case tracking-normal", onBand ? "text-fg-on-band-muted" : "text-fg-muted")}
          >
            fictional money
          </FictionLabel>
        </span>
      </span>
    </div>
  );
}
