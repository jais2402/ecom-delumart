"use client";

import { type ComponentPropsWithRef, useId, useState } from "react";
import { Button } from "../../atoms/Button";
import { Input } from "../../atoms/Input";
import { Label } from "../../atoms/Label";
import { cn } from "../../lib/cn";

export type DateRange = { from: string; to: string };

export type DateRangePickerProps = Omit<ComponentPropsWithRef<"fieldset">, "onChange" | "children"> & {
  /** The current UTC day (YYYY-MM-DD). Presets end here and custom dates cannot pass it. */
  today: string;
  from: string;
  to: string;
  onChange: (range: DateRange) => void;
  /** Preset lengths in days. */
  presets?: readonly number[];
  /** Longest range accepted, in days. */
  maxDays?: number;
};

const DAY_MS = 86_400_000;

/** Days since the epoch for a real YYYY-MM-DD date, else null. */
function dayNumber(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) return null;
  return ms / DAY_MS;
}

function shiftDay(value: string, delta: number): string {
  const n = dayNumber(value) ?? 0;
  return new Date((n + delta) * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Preset buttons (last 7, 30, 90 days) and a custom from/to pair. Pure UI: the parent keeps the
 * range (for example in the URL) and receives a valid range or nothing.
 */
export function DateRangePicker({
  today,
  from,
  to,
  onChange,
  presets = [7, 30, 90],
  maxDays = 366,
  className,
  ...props
}: DateRangePickerProps) {
  const uid = useId();
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  const [error, setError] = useState<string | null>(null);
  const [syncedTo, setSyncedTo] = useState(`${from}|${to}`);
  // follow the parent when the range changes from outside (a preset, or the browser's back button)
  if (syncedTo !== `${from}|${to}`) {
    setSyncedTo(`${from}|${to}`);
    setDraftFrom(from);
    setDraftTo(to);
    setError(null);
  }

  function apply() {
    const a = dayNumber(draftFrom);
    const b = dayNumber(draftTo);
    const t = dayNumber(today);
    if (a === null || b === null) return setError("Enter both dates.");
    if (a > b) return setError("The start date must be on or before the end date.");
    if (t !== null && b > t) return setError("The end date cannot be in the future.");
    if (b - a + 1 > maxDays) return setError(`Choose at most ${maxDays} days.`);
    setError(null);
    onChange({ from: draftFrom, to: draftTo });
  }

  const errorId = `${uid}-error`;
  return (
    <fieldset className={cn("flex min-w-0 flex-col gap-3 font-body text-fg", className)} {...props}>
      <legend className="mb-2 text-sm font-bold">Date range (UTC days)</legend>
      <div className="flex flex-wrap gap-2">
        {presets.map((days) => {
          const start = shiftDay(today, -(days - 1));
          const active = to === today && from === start;
          return (
            <Button
              key={days}
              variant={active ? "primary" : "secondary"}
              size="sm"
              aria-pressed={active}
              onClick={() => onChange({ from: start, to: today })}
            >
              {`Last ${days} days`}
            </Button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${uid}-from`}>From</Label>
          <Input
            id={`${uid}-from`}
            type="date"
            value={draftFrom}
            max={today}
            invalid={error !== null}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => setDraftFrom(event.target.value)}
            className="w-auto focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${uid}-to`}>To</Label>
          <Input
            id={`${uid}-to`}
            type="date"
            value={draftTo}
            max={today}
            invalid={error !== null}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => setDraftTo(event.target.value)}
            className="w-auto focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus"
          />
        </div>
        <Button variant="secondary" onClick={apply}>
          Apply dates
        </Button>
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
