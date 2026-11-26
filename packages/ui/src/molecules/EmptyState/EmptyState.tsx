import type { ComponentPropsWithRef, ReactNode } from "react";
import { Heading, type HeadingLevel } from "../../atoms/Heading";
import { Text } from "../../atoms/Text";
import { cn } from "../../lib/cn";

export type EmptyStateProps = Omit<ComponentPropsWithRef<"div">, "title"> & {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  headingLevel?: HeadingLevel;
};

export function EmptyState({
  title,
  description,
  icon,
  action,
  headingLevel = 2,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 rounded-lg border border-border bg-surface px-4 py-8 text-center",
        className,
      )}
      {...props}
    >
      {icon ? (
        <div className="flex size-16 items-center justify-center rounded-pill bg-action-soft text-action">
          {icon}
        </div>
      ) : null}
      <Heading level={headingLevel} size="sm">
        {title}
      </Heading>
      {description ? (
        <Text muted size="sm" className="max-w-reading">
          {description}
        </Text>
      ) : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
