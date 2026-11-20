import { type ReactNode, useId } from "react";
import { Label } from "../../atoms/Label";
import { cn } from "../../lib/cn";

export type FormFieldControlProps = {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
  required: boolean | undefined;
};

export type FormFieldProps = {
  label: ReactNode;
  /** Render the control, spreading the supplied props onto it. */
  children: (control: FormFieldControlProps) => ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
};

export function FormField({ label, children, hint, error, required, className }: FormFieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <Label htmlFor={id} required={required}>
        {label}
      </Label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined, required })}
      {hint ? (
        <p id={hintId} className="font-body text-sm text-fg-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="font-body text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
