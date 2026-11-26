"use client";

import { ChevronDown, Truck } from "lucide-react";
import { type ComponentPropsWithRef, useId } from "react";
import { Icon } from "../../atoms/Icon";
import { cn } from "../../lib/cn";
import { useDismissable } from "../../lib/useDismissable";

export type DeliverySpeed = { name: string; arrival: string };

export type DeliveryPillProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  /** Text of the pill, such as "Standard or Zap delivery". */
  label: string;
  /** The speeds offered, each with its configured arrival time. */
  speeds: readonly DeliverySpeed[];
  /** Where "How it works" goes. */
  helpHref: string;
  /** "band" is the dark pill on the blue header band; "plain" sits on white. */
  tone?: "band" | "plain";
};

/**
 * A pill that opens a small popover explaining the delivery speeds and their arrival times, with a
 * link to the page that explains them. Escape closes it and returns focus to the pill.
 */
export function DeliveryPill({
  label,
  speeds,
  helpHref,
  tone = "band",
  className,
  ...props
}: DeliveryPillProps) {
  const panelId = useId();
  const { open, setOpen, trigger, rootProps } = useDismissable();
  return (
    <div className={cn("relative", className)} {...props} {...rootProps}>
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "inline-flex min-h-touch items-center gap-2 rounded-pill py-1.5 pr-3 pl-1.5 font-body text-sm font-bold transition-colors duration-fast",
          tone === "band"
            ? "bg-ink text-fg-on-ink hover:bg-ink/90 focus-visible:outline-fg-on-band"
            : "border border-border bg-surface text-fg hover:bg-action-soft",
        )}
      >
        <span className="inline-flex size-8 items-center justify-center rounded-pill bg-sun text-fg-on-sun">
          <Icon icon={Truck} size={18} />
        </span>
        <span className="whitespace-nowrap">{label}</span>
        <Icon icon={ChevronDown} size={18} />
      </button>
      {open ? (
        <section
          id={panelId}
          aria-label="Delivery speeds"
          className="absolute top-full left-0 z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-surface p-4 text-fg shadow-overlay"
        >
          <p className="font-body text-base font-bold">Choose a speed at checkout</p>
          <dl className="mt-2 flex flex-col divide-y divide-border font-body text-sm">
            {speeds.map((speed) => (
              <div key={speed.name} className="flex items-baseline justify-between gap-4 py-2">
                <dt className="font-semibold">{speed.name}</dt>
                <dd className="text-right text-fg-muted">{speed.arrival}</dd>
              </div>
            ))}
          </dl>
          <a
            href={helpHref}
            className="mt-1 inline-flex min-h-touch items-center font-body text-sm font-semibold text-action underline underline-offset-2 hover:text-action-hover"
          >
            How it works
          </a>
        </section>
      ) : null}
    </div>
  );
}
