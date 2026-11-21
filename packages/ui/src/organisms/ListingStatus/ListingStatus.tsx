import type { ComponentPropsWithRef, ReactNode } from "react";
import { Badge } from "../../atoms/Badge";
import { cn } from "../../lib/cn";

export type ListingStatusValue =
  | "DRAFT"
  | "SCREENING"
  | "NEEDS_REVIEW"
  | "PUBLISHED"
  | "REJECTED"
  | "HIDDEN"
  | "ARCHIVED";

type Tone = "neutral" | "success" | "warning" | "danger" | "info" | "highlight";

const STATUS: Record<ListingStatusValue, { label: string; tone: Tone; message: string }> = {
  DRAFT: {
    label: "Draft",
    tone: "neutral",
    message: "Only you can see this. Submit it for review when it is ready.",
  },
  SCREENING: { label: "Being checked", tone: "info", message: "Being checked — usually quick." },
  NEEDS_REVIEW: { label: "In review", tone: "warning", message: "Waiting for a person to review." },
  PUBLISHED: { label: "Published", tone: "success", message: "Shoppers can see and buy this." },
  REJECTED: {
    label: "Not approved",
    tone: "danger",
    message: "This was not approved. Edit it and send it again.",
  },
  HIDDEN: {
    label: "Hidden",
    tone: "danger",
    message: "This was hidden by DeluluMart and shoppers cannot see it.",
  },
  ARCHIVED: { label: "Archived", tone: "neutral", message: "Archived. Shoppers cannot see it any more." },
};

export function listingStatusLabel(status: ListingStatusValue, approvedNeedsStock = false): string {
  return status === "DRAFT" && approvedNeedsStock ? "Approved, needs stock" : STATUS[status].label;
}

export type ListingStatusProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  status: ListingStatusValue;
  /** Approved by review but waiting for the seller to put units in the warehouse. */
  approvedNeedsStock?: boolean;
  /** Plain-words reasons (never the offending text). */
  reasons?: readonly string[];
  /** A person's reason, for a rejection or a hide. */
  moderationReason?: string | null;
  /** Show only the badge, without the explanation. */
  compact?: boolean;
  children?: ReactNode;
};

/** A status as text and colour together, with what it means in one sentence. */
export function ListingStatus({
  status,
  approvedNeedsStock = false,
  reasons = [],
  moderationReason = null,
  compact = false,
  children,
  className,
  ...props
}: ListingStatusProps) {
  const entry = STATUS[status];
  const needsStock = approvedNeedsStock && status !== "PUBLISHED" && status !== "ARCHIVED";
  const label = needsStock ? "Approved, needs stock" : entry.label;
  const tone: Tone = needsStock ? "highlight" : entry.tone;
  if (compact) {
    return (
      <Badge tone={tone} className={className}>
        {label}
      </Badge>
    );
  }
  return (
    <div className={cn("flex flex-col gap-2 font-body", className)} {...props}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tone}>{label}</Badge>
        <span className="text-sm text-fg">
          {needsStock ? "Approved. Put units in your warehouse to publish it." : entry.message}
        </span>
      </div>
      {reasons.length > 0 ? (
        <ul aria-label="What to change" className="list-disc pl-5 text-sm text-fg">
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
      {moderationReason ? (
        <p className="text-sm text-fg">
          <span className="font-bold">Reason given: </span>
          {moderationReason}
        </p>
      ) : null}
      {children}
    </div>
  );
}
