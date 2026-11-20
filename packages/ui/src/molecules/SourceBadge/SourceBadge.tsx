import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";

export type SourceKind = "player" | "npc" | "staff";

const config: Record<SourceKind, { text: string; classes: string }> = {
  player: { text: "PLAYER", classes: "border-source-player text-source-player" },
  npc: { text: "Simulated NPC", classes: "border-source-npc text-source-npc" },
  staff: { text: "STAFF", classes: "border-border-strong text-fg" },
};

export type SourceBadgeProps = Omit<ComponentPropsWithRef<"span">, "children"> & {
  source: SourceKind;
};

/** Always carries a text label; colour is supplementary. */
export function SourceBadge({ source, className, ...props }: SourceBadgeProps) {
  const { text, classes } = config[source];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border bg-surface px-2 py-0.5 font-body text-xs font-bold tracking-wide",
        classes,
        className,
      )}
      {...props}
    >
      {text}
    </span>
  );
}
