import { Heading } from "@delulu/ui";
import type { ReactNode } from "react";

export function Specimen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <Heading level={3} size="sm">
        {title}
      </Heading>
      <div className="flex min-w-0 flex-wrap items-start gap-3">{children}</div>
    </section>
  );
}

export function Level({
  id,
  title,
  intro,
  children,
}: {
  id: string;
  title: string;
  intro: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4">
      <div>
        <Heading level={2} size="lg" id={id}>
          {title}
        </Heading>
        <p className="max-w-reading font-body text-base text-fg-muted">{intro}</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">{children}</div>
    </section>
  );
}
