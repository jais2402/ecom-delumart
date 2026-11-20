import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";
import { TimelineItem, type TimelineState } from "../../molecules/TimelineItem";

export type TrackingStage = {
  key: string;
  title: string;
  time?: string;
  dateTime?: string;
  state: TimelineState;
  note?: string;
};

export type TrackingTimelineProps = Omit<ComponentPropsWithRef<"ol">, "children"> & {
  /** Stage data, normally five: placed, packed, on the way, nearby, delivered. */
  stages: readonly TrackingStage[];
};

export function TrackingTimeline({ stages, className, ...props }: TrackingTimelineProps) {
  return (
    <ol aria-label="Order tracking" className={cn("flex flex-col", className)} {...props}>
      {stages.map((stage) => (
        <TimelineItem
          key={stage.key}
          title={stage.title}
          state={stage.state}
          {...(stage.time ? { time: stage.time } : {})}
          {...(stage.dateTime ? { dateTime: stage.dateTime } : {})}
        >
          {stage.note ? <p className="text-sm text-fg-muted">{stage.note}</p> : null}
        </TimelineItem>
      ))}
    </ol>
  );
}
