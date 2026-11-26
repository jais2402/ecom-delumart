import type { ComponentPropsWithRef, ReactNode } from "react";
import { Heading, type HeadingLevel } from "../../atoms/Heading";
import { cn } from "../../lib/cn";

export type SectionHeadingProps = Omit<ComponentPropsWithRef<"div">, "title"> & {
  title: string;
  /** One muted line under the bold title. Keep it to a short sentence. */
  lead?: string;
  /** Id of the heading, so the section can be named by it. */
  headingId?: string;
  headingLevel?: HeadingLevel;
  /** Link to the full list, drawn as a small underlined "View all" at the right. */
  seeAll?: { href: string; label: string };
  /** Extra controls at the end of the row. */
  actions?: ReactNode;
};

/** A section's bold title, one muted subtitle line, and an underlined "View all" link at the right. */
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
    <div className={cn("flex items-start justify-between gap-x-4 gap-y-1", className)} {...props}>
      <div className="min-w-0">
        <Heading level={headingLevel} size="md" id={headingId} className="text-2xl md:text-3xl">
          {title}
        </Heading>
        {lead ? <p className="mt-1 font-body text-base text-fg-muted">{lead}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {seeAll ? (
          <a
            href={seeAll.href}
            className="inline-flex min-h-touch items-center font-body text-sm font-semibold text-fg underline underline-offset-2 hover:text-action"
          >
            {seeAll.label}
          </a>
        ) : null}
        {actions}
      </div>
    </div>
  );
}
