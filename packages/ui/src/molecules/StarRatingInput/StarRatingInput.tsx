import { Star } from "lucide-react";
import { useId } from "react";
import { cn } from "../../lib/cn";

export type StarRatingInputProps = {
  /** The group's visible name, e.g. "Your rating". */
  legend: string;
  /** 1 to 5, or null before a choice. */
  value: number | null;
  onChange: (value: number) => void;
  error?: string | null;
  disabled?: boolean;
  required?: boolean;
  className?: string;
};

const STARS = [1, 2, 3, 4, 5] as const;

/**
 * A star rating as a native radio group: one fieldset with a legend, five radios sharing a name
 * (arrow keys move between them; Tab enters and leaves the group), each named "n star(s)". The
 * radio itself is visually hidden and its star shows the choice and the focus ring.
 */
export function StarRatingInput({
  legend,
  value,
  onChange,
  error,
  disabled = false,
  required = false,
  className,
}: StarRatingInputProps) {
  const name = useId();
  const errorId = `${name}-error`;
  return (
    <fieldset
      className={cn("flex flex-col gap-1 border-0 p-0", className)}
      aria-describedby={error ? errorId : undefined}
    >
      <legend className="mb-1 font-body text-sm font-medium text-fg">
        {legend}
        {required ? <span aria-hidden="true"> *</span> : null}
      </legend>
      <div className="flex items-center gap-1">
        {STARS.map((n) => {
          const filled = value !== null && n <= value;
          return (
            <label
              key={n}
              className={cn(
                "relative inline-flex min-h-touch min-w-touch items-center justify-center",
                disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
              )}
            >
              <input
                type="radio"
                name={name}
                value={n}
                checked={value === n}
                onChange={() => onChange(n)}
                disabled={disabled}
                required={required}
                aria-label={n === 1 ? "1 star" : `${n} stars`}
                aria-invalid={error ? true : undefined}
                className="peer sr-only"
              />
              <Star
                aria-hidden="true"
                size={28}
                data-filled={filled ? "true" : "false"}
                className={cn(
                  "rounded-sm peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus",
                  filled ? "fill-sun stroke-warning" : "fill-none stroke-fg-muted",
                )}
              />
            </label>
          );
        })}
      </div>
      {error ? (
        <p id={errorId} className="font-body text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
