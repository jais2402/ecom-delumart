import type { ComponentPropsWithRef } from "react";
import { Button } from "../../atoms/Button";
import { Heading } from "../../atoms/Heading";
import { cn } from "../../lib/cn";

export type CreatorBandProps = Omit<ComponentPropsWithRef<"section">, "title" | "children"> & {
  title: string;
  text: string;
  cta: { label: string; href: string };
};

/** A light-grey section inviting people to sell: a heading, a line and one filled button. */
export function CreatorBand({ title, text, cta, className, ...props }: CreatorBandProps) {
  return (
    <section
      className={cn(
        "flex flex-col items-start gap-6 rounded-lg bg-surface p-8 md:flex-row md:items-center md:justify-between md:p-10",
        className,
      )}
      {...props}
    >
      <div className="flex max-w-xl flex-col gap-2">
        <Heading level={2} size="md" className="text-3xl">
          {title}
        </Heading>
        <p className="font-body text-base text-fg-muted">{text}</p>
      </div>
      <Button asChild size="lg" variant="cta">
        <a href={cta.href}>{cta.label}</a>
      </Button>
    </section>
  );
}
