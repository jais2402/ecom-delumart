"use client";

import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export type DialogProps = {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Element that opens the dialog (rendered via asChild). */
  trigger?: ReactNode;
  /** Required: names the dialog. */
  title: string;
  description?: string;
  /** Accessible name of the close button. */
  closeLabel?: string;
  children?: ReactNode;
  className?: string;
};

export function Dialog({
  open,
  defaultOpen,
  onOpenChange,
  trigger,
  title,
  description,
  closeLabel = "Close",
  children,
  className,
}: DialogProps) {
  return (
    <RadixDialog.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      {trigger ? <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger> : null}
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 bg-fg/50" />
        <RadixDialog.Content
          {...(description ? {} : { "aria-describedby": undefined })}
          className={cn(
            "fixed top-1/2 left-1/2 max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-surface-raised p-4 font-body text-fg shadow-overlay",
            className,
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <RadixDialog.Title className="font-display text-xl font-bold">{title}</RadixDialog.Title>
            <RadixDialog.Close
              aria-label={closeLabel}
              className="-mt-2 -mr-2 inline-flex min-h-touch min-w-touch items-center justify-center rounded-md hover:bg-action-soft"
            >
              <X aria-hidden="true" className="size-5" />
            </RadixDialog.Close>
          </div>
          {description ? (
            <RadixDialog.Description className="mt-1 text-sm text-fg-muted">
              {description}
            </RadixDialog.Description>
          ) : null}
          <div className="mt-3">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
