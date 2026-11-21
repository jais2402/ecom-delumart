import { useEffect, useState } from "react";

/** The value once it has stopped changing for `delayMs`: keeps screen-reader announcements calm while typing. */
export function useSettledValue<T>(value: T, delayMs = 700): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}
