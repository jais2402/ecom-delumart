"use client";

import { Check, Copy } from "lucide-react";
import { type ComponentPropsWithRef, useRef, useState } from "react";
import { Button } from "../../atoms/Button";
import { Icon } from "../../atoms/Icon";
import { cn } from "../../lib/cn";

export type CopyCodeProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  code: string;
  /** What the code is, for the button's name: "Copy coupon code SAVE10". */
  noun?: string;
};

/**
 * A code with a Copy button. If the browser refuses the clipboard, the code is selected so it can
 * be copied by hand, and the status line says so.
 */
export function CopyCode({ code, noun = "coupon code", className, ...props }: CopyCodeProps) {
  const ref = useRef<HTMLElement>(null);
  const [status, setStatus] = useState<"idle" | "copied" | "selected">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setStatus("copied");
    } catch {
      const node = ref.current;
      if (node) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      setStatus("selected");
    }
  }

  return (
    <div className={cn("inline-flex flex-wrap items-center gap-2 font-body", className)} {...props}>
      <code
        ref={ref}
        className="rounded-md border border-border bg-surface-raised px-2 py-1 font-mono text-base text-fg"
      >
        {code}
      </code>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => void copy()}
        aria-label={`Copy ${noun} ${code}`}
      >
        <Icon icon={status === "copied" ? Check : Copy} size={16} />
        {status === "copied" ? "Copied" : "Copy"}
      </Button>
      <span role="status" aria-live="polite" className="text-sm text-fg-muted">
        {status === "copied"
          ? "Copied to the clipboard."
          : status === "selected"
            ? "Could not copy. The code is selected: copy it by hand."
            : ""}
      </span>
    </div>
  );
}
