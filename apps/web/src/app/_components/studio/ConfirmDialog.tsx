"use client";

import { Button, Dialog } from "@delulu/ui";
import type { ReactNode } from "react";

/** A "are you sure" step: says what will happen, then Confirm or Cancel. Focus is trapped and restored by Dialog. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  busy = false,
  danger = false,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  busy?: boolean;
  danger?: boolean;
  children?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} {...(description ? { description } : {})}>
      <div className="flex flex-col gap-4">
        {children}
        <div className="flex flex-wrap gap-2">
          <Button variant={danger ? "danger" : "primary"} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
