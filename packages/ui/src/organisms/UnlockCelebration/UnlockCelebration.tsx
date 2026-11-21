import { Sparkles } from "lucide-react";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { Button } from "../../atoms/Button";
import { Heading, type HeadingLevel } from "../../atoms/Heading";
import { Icon } from "../../atoms/Icon";
import { cn } from "../../lib/cn";

export type UnlockCelebrationProps = Omit<ComponentPropsWithRef<"section">, "children"> & {
  /** How it was unlocked, e.g. "You spent down below ₹1 crore." */
  routeText: string;
  /** The next step, e.g. a link to register a shop. */
  action?: ReactNode;
  onDismiss: () => void;
  headingLevel?: HeadingLevel;
};

/** A one-time, non-blocking panel: it never traps focus and its entrance is removed under reduced motion. */
export function UnlockCelebration({
  routeText,
  action,
  onDismiss,
  headingLevel = 2,
  className,
  ...props
}: UnlockCelebrationProps) {
  return (
    <section
      aria-label="Creator studio unlocked"
      className={cn(
        "flex flex-col gap-3 rounded-lg border-2 border-action bg-highlight p-4 font-body text-fg-on-highlight shadow-raised",
        "motion-safe:transition-[opacity,transform] motion-safe:duration-base motion-safe:starting:translate-y-2 motion-safe:starting:opacity-0",
        className,
      )}
      {...props}
    >
      <div className="flex items-center gap-2">
        <Icon icon={Sparkles} size={24} />
        <Heading level={headingLevel} size="sm" className="text-fg-on-highlight">
          Your creator studio is open.
        </Heading>
      </div>
      <p className="text-base">Keep shopping or build something impossible.</p>
      <p className="text-sm">{routeText}</p>
      <div className="flex flex-wrap gap-2">
        {action}
        <Button variant="secondary" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </section>
  );
}
