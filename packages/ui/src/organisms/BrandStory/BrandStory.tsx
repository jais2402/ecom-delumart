import type { ComponentPropsWithRef } from "react";
import { Heading } from "../../atoms/Heading";
import { cn } from "../../lib/cn";
import { Stat } from "../../molecules/Stat";

export type BrandStat = { label: string; value: string };

export type BrandStoryProps = Omit<ComponentPropsWithRef<"section">, "title" | "children"> & {
  title: string;
  /** Two or three plain sentences. */
  text: string;
  /** Figures counted from data the page already has. Left out when empty. */
  stats?: readonly BrandStat[];
};

/** One calm panel: a short confident statement about the store and, beneath it, a row of true figures. */
export function BrandStory({ title, text, stats = [], className, ...props }: BrandStoryProps) {
  return (
    <section
      className={cn(
        "flex flex-col items-center gap-6 rounded-lg bg-surface px-5 py-8 text-center md:px-10 md:py-10",
        className,
      )}
      {...props}
    >
      <div className="flex max-w-2xl flex-col gap-3">
        <Heading level={2} size="md" className="text-2xl md:text-3xl">
          {title}
        </Heading>
        <p className="font-body text-base text-fg-muted md:text-lg">{text}</p>
      </div>
      {stats.length > 0 ? (
        <ul className="grid w-full max-w-2xl grid-cols-3 gap-4 border-t border-border pt-6">
          {stats.map((stat) => (
            <li key={stat.label}>
              <Stat label={stat.label} value={stat.value} className="flex-col-reverse items-center" />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
