import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";
import { SectionHeading } from "../../molecules/SectionHeading";
import { StepCard } from "../../molecules/StepCard";

export type HowItWorksStep = { title: string; text: string };

export type HowItWorksProps = Omit<ComponentPropsWithRef<"section">, "title" | "children"> & {
  title: string;
  /** A grey sentence after the title. */
  lead?: string;
  steps: readonly HowItWorksStep[];
};

/** A short numbered list of how the game works. */
export function HowItWorks({
  title,
  lead,
  steps,
  id = "how-it-works",
  className,
  ...props
}: HowItWorksProps) {
  const headingId = `${id}-title`;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cn("scroll-mt-32 flex flex-col gap-4 rounded-lg bg-surface p-5 md:p-6", className)}
      {...props}
    >
      <SectionHeading title={title} {...(lead ? { lead } : {})} headingId={headingId} />
      <ol className="grid gap-4 md:grid-cols-3">
        {steps.map((step, index) => (
          <li key={step.title}>
            <StepCard step={index + 1} title={step.title} text={step.text} className="h-full" />
          </li>
        ))}
      </ol>
    </section>
  );
}
