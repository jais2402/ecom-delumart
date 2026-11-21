import { Eye, EyeOff, Snowflake } from "lucide-react";
import type { ComponentPropsWithRef } from "react";
import { Badge } from "../../atoms/Badge";
import { Button } from "../../atoms/Button";
import { Icon } from "../../atoms/Icon";
import { VisuallyHidden } from "../../atoms/VisuallyHidden";
import { cn } from "../../lib/cn";

export type RevealableCardProps = Omit<ComponentPropsWithRef<"section">, "children"> & {
  holderName: string;
  /** The last four digits, always known. */
  lastFour: string;
  /** The full (fictional) number once the server has allowed it; null keeps the card masked. */
  number?: string | null;
  frozen?: boolean;
  alias?: string;
  /** Ask for the number (the page calls the API and may refuse with a re-sign-in message). */
  onReveal: () => void;
  /** Hide the number again. */
  onHide: () => void;
  revealing?: boolean;
};

function group(digits: string): string {
  return digits.replace(/(.{4})/g, "$1 ").trim();
}

/**
 * A card face whose reveal is controlled by the page, because showing the full number needs a
 * server check. Display only: there is deliberately no input for typing a card number.
 */
export function RevealableCard({
  holderName,
  lastFour,
  number = null,
  frozen = false,
  alias = "Delulu Card",
  onReveal,
  onHide,
  revealing = false,
  className,
  ...props
}: RevealableCardProps) {
  const revealed = number !== null;
  const Toggle = revealed ? EyeOff : Eye;
  return (
    <section
      aria-label={`${alias}${frozen ? ", frozen" : ""}`}
      className={cn(
        "w-full max-w-sm overflow-hidden rounded-lg border border-border-strong bg-surface font-body shadow-raised",
        className,
      )}
      {...props}
    >
      <div className="flex items-center justify-between gap-2 bg-action px-4 py-3 text-fg-on-action">
        <p className="font-display text-lg font-bold">Delulu Bank</p>
        {frozen ? (
          <Badge tone="info">
            <Icon icon={Snowflake} size={12} />
            Frozen
          </Badge>
        ) : null}
      </div>
      <div className={cn("flex flex-col gap-3 p-4", frozen && "opacity-70")}>
        <div className="flex flex-wrap items-center gap-2">
          {revealed ? (
            <span className="font-mono text-lg tracking-wider text-fg">
              {group(number.replace(/\D/g, ""))}
            </span>
          ) : (
            <>
              <span aria-hidden="true" className="font-mono text-lg tracking-wider text-fg">
                •••• •••• •••• {lastFour}
              </span>
              <VisuallyHidden>Card number ending in {lastFour}</VisuallyHidden>
            </>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            loading={revealing}
            aria-pressed={revealed}
            aria-label={revealed ? "Hide card number" : "Reveal card number"}
            onClick={revealed ? onHide : onReveal}
          >
            <Toggle aria-hidden="true" className="size-4" />
            {revealed ? "Hide" : "Reveal"}
          </Button>
        </div>
        <p className="text-base font-medium uppercase tracking-wide text-fg">{holderName}</p>
        <p className="text-xs font-bold tracking-wide text-fg-muted">VIRTUAL · DELULUMART ONLY</p>
      </div>
    </section>
  );
}
