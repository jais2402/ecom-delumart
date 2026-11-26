import { distributionPercents, formatAverage } from "@delulu/core";
import { ProgressBar, StarRating, Text } from "@delulu/ui";

/** The average (stars and one decimal), the count and one bar per star level, 5 down to 1. */
export function ReviewSummary({
  averageTenths,
  count,
  distribution,
}: {
  averageTenths: number;
  count: number;
  /** Counts of 1 to 5 stars. */
  distribution: readonly number[];
}) {
  const percents = distributionPercents(distribution);
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-8">
      <div className="flex flex-col gap-1">
        <p className="font-display text-4xl font-bold text-fg" aria-hidden="true">
          {count > 0 ? formatAverage(averageTenths) : "–"}
        </p>
        <StarRating averageTenths={averageTenths} count={count} />
        <Text size="sm" muted aria-hidden="true">
          {count === 1 ? "1 review" : `${count} reviews`}
        </Text>
      </div>
      <ul aria-label="Ratings by stars" className="flex min-w-0 flex-1 flex-col gap-1">
        {[5, 4, 3, 2, 1].map((stars) => {
          const n = distribution[stars - 1] ?? 0;
          const pct = percents[stars - 1] ?? 0;
          return (
            <li key={stars} className="grid grid-cols-[4.5rem_minmax(0,1fr)_3rem] items-center gap-2">
              <Text as="span" size="sm">
                {stars} {stars === 1 ? "star" : "stars"}
              </Text>
              <ProgressBar value={pct} label={`${stars} ${stars === 1 ? "star" : "stars"}: ${n} (${pct}%)`} />
              <Text as="span" size="sm" muted className="text-right">
                {pct}%
              </Text>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
