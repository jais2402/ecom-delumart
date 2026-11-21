import type { ComponentPropsWithRef, ReactNode } from "react";
import { Button } from "../../atoms/Button";
import { FictionLabel } from "../../atoms/FictionLabel";
import { Heading, type HeadingLevel } from "../../atoms/Heading";
import { Price } from "../../atoms/Price";
import { cn } from "../../lib/cn";
import { Alert } from "../../molecules/Alert";

export type RegistrationReviewProps = Omit<ComponentPropsWithRef<"section">, "children"> & {
  displayName: string;
  handle: string;
  feePaise: bigint;
  sponsorshipPaise: bigint;
  payablePaise: bigint;
  /** Null when the server could not say. */
  balanceAfterPaise: bigint | null;
  sufficient: boolean;
  /** The quote ran out; offer a fresh one instead of the payment controls. */
  expired?: boolean;
  onRefresh: () => void;
  refreshing?: boolean;
  /** Payment method choice and actions; hidden while expired. */
  children?: ReactNode;
  headingLevel?: HeadingLevel;
};

/** The quote for registering a shop, in plain terms. The fee is a setup fee, not a purchase. */
export function RegistrationReview({
  displayName,
  handle,
  feePaise,
  sponsorshipPaise,
  payablePaise,
  balanceAfterPaise,
  sufficient,
  expired = false,
  onRefresh,
  refreshing = false,
  children,
  headingLevel = 2,
  className,
  ...props
}: RegistrationReviewProps) {
  return (
    <section
      aria-label="Company registration review"
      className={cn(
        "flex flex-col gap-4 rounded-lg border border-border-strong bg-surface p-4 font-body",
        className,
      )}
      {...props}
    >
      <Heading level={headingLevel} size="sm">
        Company registration · virtual fee
      </Heading>
      <dl className="flex flex-col gap-2 text-base">
        <div className="flex flex-wrap justify-between gap-x-3">
          <dt className="text-fg-muted">Shop</dt>
          <dd className="break-words text-right text-fg">{displayName}</dd>
        </div>
        <div className="flex flex-wrap justify-between gap-x-3">
          <dt className="text-fg-muted">Address</dt>
          <dd className="break-all font-mono text-fg">/store/{handle}</dd>
        </div>
        <div className="flex flex-wrap justify-between gap-x-3">
          <dt className="text-fg-muted">Registration fee</dt>
          <dd>
            <Price amountPaise={feePaise} display="exact" />
          </dd>
        </div>
        {sponsorshipPaise > 0n ? (
          <div className="flex flex-wrap justify-between gap-x-3">
            <dt className="text-fg-muted">Covered for you</dt>
            <dd>
              <Price amountPaise={sponsorshipPaise} display="exact" />{" "}
              <span className="text-sm text-fg-muted">— one time only</span>
            </dd>
          </div>
        ) : null}
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 border-t border-border pt-2">
          <dt className="font-medium text-fg">Amount payable</dt>
          <dd>
            <Price amountPaise={payablePaise} display="exact" className="text-lg" />
          </dd>
        </div>
        <div className="flex flex-wrap justify-between gap-x-3">
          <dt className="text-fg-muted">Balance after</dt>
          <dd>
            {balanceAfterPaise === null ? (
              <span className="text-fg-muted">Not available</span>
            ) : (
              <Price amountPaise={balanceAfterPaise} display="exact" />
            )}
          </dd>
        </div>
      </dl>
      <FictionLabel>Fictional money. No real card or bank details are used.</FictionLabel>
      <p className="text-sm text-fg-muted">
        This is a one-time setup fee, not a product purchase. This name is held for you for five minutes.
      </p>
      {expired ? (
        <Alert tone="warning" title="This quote has expired">
          <p>Nothing was charged. Get a fresh quote to keep going.</p>
          <Button variant="secondary" loading={refreshing} onClick={onRefresh} className="mt-2">
            Get a fresh quote
          </Button>
        </Alert>
      ) : (
        <>
          {!sufficient ? (
            <Alert tone="danger" title="Not enough fictional money">
              Your balance does not cover this fee. Nothing was charged.
            </Alert>
          ) : null}
          {children}
        </>
      )}
    </section>
  );
}
