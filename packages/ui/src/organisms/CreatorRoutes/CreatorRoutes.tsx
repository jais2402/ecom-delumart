import { CheckCircle2, Circle } from "lucide-react";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { Badge } from "../../atoms/Badge";
import { Button } from "../../atoms/Button";
import { FictionLabel } from "../../atoms/FictionLabel";
import { Heading, type HeadingLevel } from "../../atoms/Heading";
import { Icon } from "../../atoms/Icon";
import { Price } from "../../atoms/Price";
import { ProgressBar } from "../../atoms/ProgressBar";
import { cn } from "../../lib/cn";

export type CreatorRoutesProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  spend: {
    /** Null when the balance is not known (signed out). */
    balancePaise: bigint | null;
    /** Spending down below this unlocks; exactly this does not. */
    thresholdPaise: bigint;
    /** Where the balance started, to measure progress from. */
    startingBalancePaise: bigint;
    reached: boolean;
  };
  passport: {
    steps: readonly { label: string; done: boolean }[];
    href: string;
  };
  /** Which route unlocked creator access, when one did. */
  unlockedBy?: "SPEND" | "PASSPORT" | null;
  /** Signed-out visitors get a sign-in action instead of live progress. */
  signedOut?: boolean;
  signInAction?: ReactNode;
  headingLevel?: HeadingLevel;
};

/** Both ways to unlock creator access, side by side and of equal weight. */
export function CreatorRoutes({
  spend,
  passport,
  unlockedBy = null,
  signedOut = false,
  signInAction,
  headingLevel = 2,
  className,
  ...props
}: CreatorRoutesProps) {
  const { balancePaise, thresholdPaise, startingBalancePaise } = spend;
  const toSpend = startingBalancePaise - thresholdPaise;
  const spent = balancePaise === null ? 0n : startingBalancePaise - balancePaise;
  const clamped = spent < 0n ? 0n : spent > toSpend ? toSpend : spent;
  // basis points of the way down; a display ratio only, never used as money
  const basisPoints = toSpend > 0n ? Number((clamped * 10_000n) / toSpend) : 0;
  const stillToSpend = balancePaise === null ? null : balancePaise - thresholdPaise + 1n;
  const doneCount = passport.steps.filter((step) => step.done).length;
  const card = "flex min-w-0 flex-col gap-3 rounded-lg border border-border-strong bg-surface p-4";

  return (
    <div className={cn("grid gap-4 font-body md:grid-cols-2", className)} {...props}>
      <section aria-labelledby="route-spend" className={card} data-route="spend">
        <div className="flex flex-wrap items-center gap-2">
          <Heading level={headingLevel} size="sm" id="route-spend">
            Spend down below <Price amountPaise={thresholdPaise} className="font-display text-xl font-bold" />
          </Heading>
          {unlockedBy === "SPEND" ? <Badge tone="success">Unlocked this way</Badge> : null}
        </div>
        {balancePaise !== null ? (
          <dl className="flex flex-col gap-1 text-base">
            <div className="flex flex-wrap justify-between gap-x-3">
              <dt className="text-fg-muted">Your balance</dt>
              <dd>
                <Price amountPaise={balancePaise} display="exact" />
              </dd>
            </div>
            <div className="flex flex-wrap justify-between gap-x-3">
              <dt className="text-fg-muted">Needs to be below</dt>
              <dd>
                <Price amountPaise={thresholdPaise} display="exact" />
              </dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-fg-muted">
            Everyone starts with <Price amountPaise={startingBalancePaise} /> of fictional money.
          </p>
        )}
        {balancePaise !== null ? (
          <>
            <ProgressBar
              label="Progress spending down to the creator threshold"
              value={basisPoints}
              max={10_000}
            />
            <p className="text-sm">
              {spend.reached || (stillToSpend !== null && stillToSpend <= 0n) ? (
                "Your balance is below the line."
              ) : (
                <>
                  Spend at least{" "}
                  <Price amountPaise={stillToSpend ?? 0n} display="exact" className="text-sm" /> more.
                </>
              )}
            </p>
          </>
        ) : null}
        <p className="text-sm text-fg-muted">
          Exactly <Price amountPaise={thresholdPaise} className="text-sm" /> does not count: your balance has
          to be below it.
        </p>
        <FictionLabel>Fictional money</FictionLabel>
      </section>

      <section aria-labelledby="route-passport" className={card} data-route="passport">
        <div className="flex flex-wrap items-center gap-2">
          <Heading level={headingLevel} size="sm" id="route-passport">
            Inventor Passport — free
          </Heading>
          {unlockedBy === "PASSPORT" ? <Badge tone="success">Unlocked this way</Badge> : null}
        </div>
        {signedOut ? (
          <p className="text-sm text-fg-muted">A short quiz, three saved products and a private idea.</p>
        ) : (
          <>
            <p className="text-sm">
              {doneCount} of {passport.steps.length} steps done. Do them in any order.
            </p>
            <ul className="flex flex-col gap-1">
              {passport.steps.map((step) => (
                <li key={step.label} className="flex items-center gap-2 text-base">
                  <Icon
                    icon={step.done ? CheckCircle2 : Circle}
                    className={step.done ? "text-success" : "text-fg-muted"}
                  />
                  <span>{step.label}</span>
                  <span className="ml-auto text-sm text-fg-muted">{step.done ? "Done" : "To do"}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {signedOut ? null : (
          <Button asChild variant="secondary" className="self-start">
            <a href={passport.href}>{doneCount === 0 ? "Start the passport" : "Open the passport"}</a>
          </Button>
        )}
      </section>
      {signedOut && signInAction ? <div className="md:col-span-2">{signInAction}</div> : null}
    </div>
  );
}
