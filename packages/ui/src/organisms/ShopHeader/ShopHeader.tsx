import type { ComponentPropsWithRef, ReactNode } from "react";
import { Badge } from "../../atoms/Badge";
import { Heading, type HeadingLevel } from "../../atoms/Heading";
import { Text } from "../../atoms/Text";
import { cn } from "../../lib/cn";

export type ShopHeaderProps = Omit<ComponentPropsWithRef<"header">, "children"> & {
  displayName: string;
  handle: string;
  description: string;
  /** e.g. "SOLO"; shown as a badge. */
  tier?: string;
  headingLevel?: HeadingLevel;
  children?: ReactNode;
};

const tierName = (tier: string) => tier.charAt(0) + tier.slice(1).toLowerCase();

/** A shop's identity: name, address, tier and description. Shows only what the public may see. */
export function ShopHeader({
  displayName,
  handle,
  description,
  tier,
  headingLevel = 1,
  children,
  className,
  ...props
}: ShopHeaderProps) {
  return (
    <header className={cn("flex flex-col gap-2 font-body", className)} {...props}>
      <div className="flex flex-wrap items-center gap-2">
        <Heading level={headingLevel} size="lg" className="break-words">
          {displayName}
        </Heading>
        {tier ? <Badge tone="highlight">{tierName(tier)} shop</Badge> : null}
      </div>
      <Text size="sm" muted className="break-all font-mono">
        /store/{handle}
      </Text>
      {description ? (
        <Text className="max-w-reading whitespace-pre-line break-words">{description}</Text>
      ) : null}
      {children}
    </header>
  );
}
