"use client";

import { type FocusEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";

/**
 * The open and close behaviour shared by the header's menus and popovers: Escape closes and puts
 * focus back on the trigger; so does a press outside or moving focus out. Spread `rootProps` on
 * the element that wraps the trigger and the panel.
 */
export function useDismissable() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) trigger.current?.focus();
  }, []);

  const rootProps = {
    ref: root,
    onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && open) {
        event.stopPropagation();
        close(true);
      }
    },
    onBlur(event: FocusEvent) {
      if (open && !root.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
    },
  };

  return { open, setOpen, close, root, trigger, rootProps };
}
