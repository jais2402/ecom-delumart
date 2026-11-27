import type { ComponentPropsWithRef } from "react";
import { Heading } from "../../atoms/Heading";
import { cn } from "../../lib/cn";

export type InfoSectionProps = Omit<ComponentPropsWithRef<"section">, "title"> & {
  /** The section's own anchor, so a link such as `/help#delivery` lands on it. Required. */
  id: string;
  title: string;
};

/**
 * One titled section of an information page (help, policy) in a white panel. The title names the
 * section for assistive tech and the id is the anchor other pages link to; it clears the sticky header.
 */
export function InfoSection({ id, title, className, children, ...props }: InfoSectionProps) {
  const headingId = `${id}-title`;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cn("flex scroll-mt-32 flex-col gap-3 rounded-lg bg-surface p-4 md:p-6", className)}
      {...props}
    >
      <Heading level={2} size="md" id={headingId}>
        {title}
      </Heading>
      <div className="flex max-w-reading flex-col gap-3 font-body text-base text-fg [&_a]:inline-flex [&_a]:min-h-touch [&_a]:items-center [&_a]:text-action [&_a]:underline [&_h3]:mt-2 [&_h3]:text-lg [&_h3]:font-bold [&_li]:pl-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5">
        {children}
      </div>
    </section>
  );
}
