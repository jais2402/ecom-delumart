import { ArrowRight } from "lucide-react";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { Heading, type HeadingLevel } from "../../atoms/Heading";
import { Icon } from "../../atoms/Icon";
import { cn } from "../../lib/cn";

export type SectionHeadingProps = Omit<ComponentPropsWithRef<"div">, "title"> & {
  title: string;
  /** A grey continuation on the same line, after the bold title. Keep it to a short sentence. */
  lead?: string;
  /** Id of the heading, so the section can be named by it. */
  headingId?: string;
  headingLevel?: HeadingLevel;
  /** Link to the full list. */
  seeAll?: { href: string; label: string };
  /** Extra controls at the end of the row. */
  actions?: ReactNode;
};

/** A section's bold title with an optional "see all" link and controls. */
export function SectionHeading({
  title,
  lead,
  headingId,
  headingLevel = 2,
  seeAll,
  actions,
  className,
  ...props
}: SectionHeadingProps) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-x-4 gap-y-1", className)} {...props}>
      <Heading level={headingLevel} size="md" id={headingId} className="min-w-0 text-3xl">
        {title}
        {lead ? (
          <>
            {" "}
            <span className="font-normal text-fg-muted">{lead}</span>
          </>
        ) : null}
      </Heading>
      <div className="flex items-center gap-2">
        {seeAll ? (
          <a
            href={seeAll.href}
            className="inline-flex min-h-touch items-center gap-1 rounded-md px-2 font-body text-sm font-semibold text-action hover:underline"
          >
            {seeAll.label}
            <Icon icon={ArrowRight} size={16} />
          </a>
        ) : null}
        {actions}
      </div>
    </div>
  );
}
