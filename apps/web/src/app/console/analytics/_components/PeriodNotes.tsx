"use client";

import { Alert, Text } from "@delulu/ui";
import { formatDay, formatStamp } from "../_lib/range";

/** The period, when the figures were read, and a warning when traffic does not cover every day. */
export function PeriodNotes({
  from,
  to,
  days,
  trafficDays,
  asOf,
  extra,
}: {
  from: string;
  to: string;
  days: number;
  trafficDays: number;
  asOf: string;
  extra?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Text size="sm">
        {`${formatDay(from)} to ${formatDay(to)} (${days} ${days === 1 ? "day" : "days"}, UTC). As of ${formatStamp(asOf)}.`}
        {extra ? ` ${extra}` : ""}
      </Text>
      {trafficDays < days ? (
        <Alert tone="info" title="Traffic data is partial">
          {`Traffic data covers ${trafficDays} of ${days} days. Days not yet rolled up are left out of visitor counts, not counted as zero.`}
        </Alert>
      ) : null}
    </div>
  );
}
