import { Badge, Heading, StarRating, Text } from "@delulu/ui";
import { formatReviewDay, type PublicReviewItem } from "../../_lib/reviews";

/** One page of public reviews, newest first. Authors are a public handle or "Verified owner". */
export function ReviewList({ items }: { items: readonly PublicReviewItem[] }) {
  return (
    <ol aria-label="Reviews" className="flex flex-col divide-y divide-border">
      {items.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: public reviews have no id by design (decisions.md #14)
        <li key={i} className="flex flex-col gap-2 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <StarRating averageTenths={r.rating * 10} label={`Rated ${r.rating} out of 5`} size="sm" />
            {r.title ? (
              <Heading level={4} size="sm" className="text-base break-words">
                {r.title}
              </Heading>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {r.author ? (
              <Text as="span" size="sm" className="font-medium break-all">
                @{r.author.handle}
              </Text>
            ) : null}
            <Badge tone="success">Verified owner</Badge>
            <Text as="span" size="sm" muted>
              {formatReviewDay(r.createdOn)}
              {r.edited ? " · Edited" : ""}
            </Text>
          </div>
          {r.body ? <Text className="whitespace-pre-wrap break-words">{r.body}</Text> : null}
        </li>
      ))}
    </ol>
  );
}
