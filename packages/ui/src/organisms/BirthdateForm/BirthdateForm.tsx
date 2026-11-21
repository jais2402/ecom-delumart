"use client";

import { isAdult } from "@delulu/core";
import { type ComponentPropsWithRef, type FormEvent, type Ref, useId, useRef, useState } from "react";
import { Button } from "../../atoms/Button";
import { Heading } from "../../atoms/Heading";
import { Label } from "../../atoms/Label";
import { Select } from "../../atoms/Select";
import { cn } from "../../lib/cn";
import { Alert } from "../../molecules/Alert";

export type BirthdateFormProps = Omit<ComponentPropsWithRef<"div">, "children" | "onSubmit"> & {
  /** Receives YYYY-MM-DD. */
  onSubmit: (isoDate: string) => Promise<void>;
  pending?: boolean;
  error?: string | null;
  /** Today as YYYY-MM-DD; supplied by the caller so tests are deterministic. Defaults to the local date. */
  today?: string;
  headingRef?: Ref<HTMLHeadingElement>;
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const YEARS_SHOWN = 100;

const pad = (n: number) => String(n).padStart(2, "0");

function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function BirthdateForm({
  onSubmit,
  pending = false,
  error,
  today,
  headingRef,
  className,
  ...props
}: BirthdateFormProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const errorId = `${id}-error`;
  const [day, setDay] = useState("");
  const [month, setMonth] = useState("");
  const [year, setYear] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const dayRef = useRef<HTMLSelectElement>(null);
  const reference = today ?? localToday();
  const thisYear = Number(reference.slice(0, 4));
  const years = Array.from({ length: YEARS_SHOWN + 1 }, (_, i) => thisYear - i);
  const describedBy = fieldError ? `${noteId} ${errorId}` : noteId;

  function fail(message: string) {
    setFieldError(message);
    dayRef.current?.focus();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!day || !month || !year) {
      fail("Choose your day, month and year.");
      return;
    }
    const iso = `${year}-${pad(Number(month))}-${pad(Number(day))}`;
    let adult: boolean;
    try {
      adult = isAdult(iso, reference);
    } catch {
      fail("That date does not exist. Check the day and month.");
      return;
    }
    if (!adult) {
      fail("DeluluMart is for adults aged 18 or over.");
      return;
    }
    setFieldError(null);
    void onSubmit(iso).catch(() => undefined);
  }

  const clear = () => {
    if (fieldError) setFieldError(null);
  };
  const invalid = Boolean(fieldError);

  return (
    <div className={cn("flex flex-col gap-4", className)} {...props}>
      <Heading level={1} size="md" tabIndex={-1} ref={headingRef}>
        When were you born?
      </Heading>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        <fieldset aria-describedby={describedBy} className="flex min-w-0 flex-col gap-2 border-0 p-0">
          <legend className="mb-1 font-body text-sm font-medium text-fg">Date of birth</legend>
          <div className="grid grid-cols-[1fr_2fr_1.3fr] gap-2">
            <div className="flex min-w-0 flex-col gap-1">
              <Label htmlFor={`${id}-day`}>Day</Label>
              <Select
                id={`${id}-day`}
                ref={dayRef}
                required
                invalid={invalid}
                aria-describedby={describedBy}
                value={day}
                onChange={(e) => {
                  setDay(e.target.value);
                  clear();
                }}
              >
                <option value="">Day</option>
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <Label htmlFor={`${id}-month`}>Month</Label>
              <Select
                id={`${id}-month`}
                required
                invalid={invalid}
                aria-describedby={describedBy}
                value={month}
                onChange={(e) => {
                  setMonth(e.target.value);
                  clear();
                }}
              >
                <option value="">Month</option>
                {MONTHS.map((name, i) => (
                  <option key={name} value={i + 1}>
                    {name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <Label htmlFor={`${id}-year`}>Year</Label>
              <Select
                id={`${id}-year`}
                required
                invalid={invalid}
                aria-describedby={describedBy}
                value={year}
                onChange={(e) => {
                  setYear(e.target.value);
                  clear();
                }}
              >
                <option value="">Year</option>
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        </fieldset>
        <p id={noteId} className="font-body text-sm text-fg-muted">
          Visible only to you. It is never shown to other players and is not used for marketing.
        </p>
        {fieldError ? (
          <p id={errorId} className="font-body text-sm font-medium text-danger">
            {fieldError}
          </p>
        ) : null}
        <Button type="submit" size="lg" loading={pending}>
          Continue
        </Button>
      </form>
    </div>
  );
}
