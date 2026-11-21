"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import { parseRange, queryString, todayUtc } from "./range";

/** The screen's state lives in the URL: `go` writes a full query, so the page can be shared and reloaded. */
export function useUrlState() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const [today] = useState(() => todayUtc());
  const range = parseRange(params, today);
  const go = useCallback(
    (values: Record<string, string | null | undefined>, mode: "push" | "replace" = "push") => {
      const qs = queryString(values);
      const url = qs ? `${pathname}?${qs}` : pathname;
      if (mode === "push") router.push(url);
      else router.replace(url);
    },
    [pathname, router],
  );
  return { params, range, today, go };
}
