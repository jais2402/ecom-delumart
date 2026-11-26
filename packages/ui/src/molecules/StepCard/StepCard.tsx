import type { ComponentPropsWithRef } from "react";
import { Heading, type HeadingLevel } from "../../atoms/Heading";
import { cn } from "../../lib/cn";

export type StepCardProps = Omit<ComponentPropsWithRef<"div">, "title" | "children"> & {
  step: number;
  title: string;
  text: string;
  headingLevel?: HeadingLevel;
};

/** One numbered step of a short how-it-works list. */
export function StepCard({ step, title, text, headingLevel = 3, className, ...props }: StepCardProps) {
  return (
    <div className={cn("flex flex-col gap-2 rounded-lg bg-surface-raised p-4 md:p-5", className)} {...props}>
      <span
        aria-hidden="true"
        className="inline-flex size-9 items-center justify-center rounded-pill bg-band font-body text-base font-bold text-fg-on-band"
      >
        {step}
      </span>
      <Heading level={headingLevel} size="sm">
        <span className="sr-only">Step {step}:</span> {title}
      </Heading>
      <p className="font-body text-sm text-fg-muted">{text}</p>
    </div>
  );
}
