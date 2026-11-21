import { type ComponentPropsWithRef, useId } from "react";
import { cn } from "../../lib/cn";

export type FunnelStep = {
  key: string;
  label: string;
  visitors: number;
  /** 0..1 against the step before; null for the first step or when that step is empty. */
  conversionFromPrevious: number | null;
};

export type FunnelChartProps = Omit<ComponentPropsWithRef<"figure">, "children"> & {
  steps: readonly FunnelStep[];
  /** 0..1, first step to last; null when the first step is empty. */
  overallConversion: number | null;
  /** Names the chart. */
  caption: string;
};

/** A 0..1 ratio as a percentage with one decimal at most, e.g. 0.5 -> "50%". */
export function formatRatio(ratio: number): string {
  return `${Math.round(ratio * 1000) / 10}%`;
}

/**
 * Horizontal bars, one per step, each as wide as its share of the first step. Every bar carries
 * its count and its conversion from the step before in text, so the chart never relies on colour.
 */
export function FunnelChart({ steps, overallConversion, caption, className, ...props }: FunnelChartProps) {
  const captionId = useId();
  const top = steps.reduce((max, s) => Math.max(max, s.visitors), 0);
  return (
    <figure
      aria-labelledby={captionId}
      className={cn("flex min-w-0 flex-col gap-3 font-body text-fg", className)}
      {...props}
    >
      <figcaption id={captionId} className="font-bold">
        {caption}
      </figcaption>
      <ol aria-label={`${caption}: steps`} className="flex flex-col gap-3">
        {steps.map((step, index) => {
          const width = top > 0 ? Math.round((step.visitors / top) * 1000) / 10 : 0;
          return (
            <li key={step.key} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                <span className="font-medium">{`${index + 1}. ${step.label}`}</span>
                <span className="tabular-nums">
                  <strong>{step.visitors.toLocaleString("en-IN")}</strong>
                  <span className="text-fg-muted">
                    {step.conversionFromPrevious === null
                      ? index === 0
                        ? " · start of the funnel"
                        : " · no earlier step to compare"
                      : ` · ${formatRatio(step.conversionFromPrevious)} of the step before`}
                  </span>
                </span>
              </div>
              <div aria-hidden="true" className="h-4 w-full rounded-sm bg-surface-raised">
                <div
                  data-testid="funnel-bar"
                  className="h-4 rounded-sm border border-action bg-action-soft"
                  style={{ width: `${width}%`, minWidth: step.visitors > 0 ? "4px" : undefined }}
                />
              </div>
            </li>
          );
        })}
      </ol>
      <p className="text-sm text-fg-muted">
        {overallConversion === null
          ? "Overall conversion is not available: there are no visitors in this period."
          : `Overall: ${formatRatio(overallConversion)} of the first step reached the last. Counts are daily visitors, summed over the period.`}
      </p>
    </figure>
  );
}
