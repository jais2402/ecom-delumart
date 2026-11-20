"use client";

import { Eye, EyeOff } from "lucide-react";
import { type ComponentPropsWithRef, useState } from "react";
import { Button } from "../../atoms/Button";
import { VisuallyHidden } from "../../atoms/VisuallyHidden";
import { cn } from "../../lib/cn";

export type CardNumberProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  /** The (fictional) card number; digits, spaces allowed. Display only. */
  number: string;
  defaultRevealed?: boolean;
};

function group(digits: string): string {
  return digits.replace(/(.{4})/g, "$1 ").trim();
}

/** Display only: there is deliberately no input for typing a card number. */
export function CardNumber({ number, defaultRevealed = false, className, ...props }: CardNumberProps) {
  const [revealed, setRevealed] = useState(defaultRevealed);
  const digits = number.replace(/\D/g, "");
  const lastFour = digits.slice(-4);
  const masked = group(`${"•".repeat(Math.max(digits.length - 4, 0))}${lastFour}`);
  const Toggle = revealed ? EyeOff : Eye;
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)} {...props}>
      {revealed ? (
        <span className="font-mono text-lg tracking-wider text-fg">{group(digits)}</span>
      ) : (
        <>
          <span aria-hidden="true" className="font-mono text-lg tracking-wider text-fg">
            {masked}
          </span>
          <VisuallyHidden>Card number ending in {lastFour}</VisuallyHidden>
        </>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-pressed={revealed}
        aria-label={revealed ? "Hide card number" : "Reveal card number"}
        onClick={() => setRevealed((r) => !r)}
      >
        <Toggle aria-hidden="true" className="size-4" />
        {revealed ? "Hide" : "Reveal"}
      </Button>
    </div>
  );
}
