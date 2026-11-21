import { CheckCircle2, Circle } from "lucide-react";
import { type ComponentPropsWithRef, type ReactNode, useId } from "react";
import { Badge } from "../../atoms/Badge";
import { Heading, type HeadingLevel } from "../../atoms/Heading";
import { Icon } from "../../atoms/Icon";
import { cn } from "../../lib/cn";

export type PassportStepCardProps = Omit<ComponentPropsWithRef<"section">, "title" | "children"> & {
  title: string;
  done: boolean;
  /** One line under the title, e.g. "2 of 3 saved". */
  summary?: ReactNode;
  headingLevel?: HeadingLevel;
  children?: ReactNode;
};

/** One passport step: a titled card whose state is always written out, never only a colour. */
export function PassportStepCard({
  title,
  done,
  summary,
  headingLevel = 2,
  children,
  className,
  ...props
}: PassportStepCardProps) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      data-done={done}
      className={cn(
        "flex flex-col gap-3 rounded-lg border bg-surface p-4 font-body",
        done ? "border-success" : "border-border-strong",
        className,
      )}
      {...props}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Icon icon={done ? CheckCircle2 : Circle} className={done ? "text-success" : "text-fg-muted"} />
        <Heading level={headingLevel} size="sm" id={titleId}>
          {title}
        </Heading>
        <Badge tone={done ? "success" : "neutral"} className="ml-auto">
          {done ? "Done" : "To do"}
        </Badge>
      </div>
      {summary ? <p className="text-sm text-fg-muted">{summary}</p> : null}
      {children}
    </section>
  );
}
