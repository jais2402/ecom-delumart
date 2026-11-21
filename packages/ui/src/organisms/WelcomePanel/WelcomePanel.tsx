import { formatInrCompact } from "@delulu/core";
import type { ComponentPropsWithRef, Ref } from "react";
import { Button } from "../../atoms/Button";
import { FictionLabel } from "../../atoms/FictionLabel";
import { Heading } from "../../atoms/Heading";
import { Text } from "../../atoms/Text";
import { cn } from "../../lib/cn";
import { VirtualCard } from "../VirtualCard";

export type WelcomePanelProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  /** Starting balance in paise. */
  balancePaise: bigint;
  /** Fictional card number; shown masked by the card. Display only. */
  cardNumber: string;
  holderName?: string;
  shopHref?: string;
  headingRef?: Ref<HTMLHeadingElement>;
};

export function WelcomePanel({
  balancePaise,
  cardNumber,
  holderName = "Delulu Player",
  shopHref = "/",
  headingRef,
  className,
  ...props
}: WelcomePanelProps) {
  return (
    <div className={cn("flex flex-col gap-4", className)} {...props}>
      <Heading level={1} size="md" tabIndex={-1} ref={headingRef}>
        You&apos;re in. Welcome to DeluluMart.
      </Heading>
      <div className="flex flex-col gap-1 rounded-lg bg-action-soft p-4">
        <FictionLabel>Your starting balance</FictionLabel>
        <p className="font-display text-3xl font-bold text-fg">
          {formatInrCompact(balancePaise)} · fictional money
        </p>
      </div>
      <VirtualCard holderName={holderName} number={cardNumber} alias="Your Delulu Card" />
      <Text muted>Your card number is hidden by default. You need your game PIN to pay with it.</Text>
      <Button asChild size="lg">
        <a href={shopHref}>Start shopping</a>
      </Button>
    </div>
  );
}
