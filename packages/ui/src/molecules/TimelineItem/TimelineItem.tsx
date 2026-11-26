import type { ComponentPropsWithRef, ReactNode } from "react";
import { VisuallyHidden } from "../../atoms/VisuallyHidden";
import { cn } from "../../lib/cn";

export type TimelineState = "done" | "current" | "upcoming";

const stateText: Record<TimelineState, string> = { done: "Done", current: "Current", upcoming: "Upcoming" };

export type TimelineItemProps = Omit<ComponentPropsWithRef<"li">, "title"> & {
  title: ReactNode;
  /** Human-readable time, e.g. "Tue, 9:30 am". */
  time?: string;
  /** Machine-readable value for the <time> element. */
  dateTime?: string;
  state?: TimelineState;
};

/** Render inside an <ol>. */
export function TimelineItem({
  title,
  time,
  dateTime,
  state = "upcoming",
  className,
  children,
  ...props
}: TimelineItemProps) {
  return (
    <li
      aria-current={state === "current" ? "step" : undefined}
      className={cn(
        "relative flex gap-3 font-body before:absolute before:top-[1.375rem] before:bottom-0 before:left-[7px] before:w-0.5 last:before:hidden",
        state === "done" ? "before:bg-action" : "before:bg-border",
        state === "upcoming" ? "text-fg-muted" : "text-fg",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          "mt-1.5 size-4 shrink-0 rounded-pill border-2",
          state === "done" && "border-action bg-action",
          state === "current" && "border-action bg-surface ring-4 ring-action-soft",
          state === "upcoming" && "border-border-strong bg-surface",
        )}
      />
      <div className="min-w-0 pb-4">
        <p className={cn("text-base", state === "current" ? "font-bold" : "font-medium")}>
          <VisuallyHidden>{stateText[state]}: </VisuallyHidden>
          {title}
        </p>
        {time ? (
          <time dateTime={dateTime} className="text-sm text-fg-muted">
            {time}
          </time>
        ) : null}
        {children ? <div className="text-sm">{children}</div> : null}
      </div>
    </li>
  );
}
