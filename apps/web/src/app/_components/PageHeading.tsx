"use client";

import { Heading } from "@delulu/ui";
import { type ReactNode, useEffect, useRef } from "react";

/** The page's single h1. Takes focus when the page appears so keyboard and screen reader users start here. */
export function PageHeading({ children, size = "lg" }: { children: ReactNode; size?: "md" | "lg" | "xl" }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <Heading level={1} size={size} tabIndex={-1} ref={ref} className="outline-none">
      {children}
    </Heading>
  );
}
