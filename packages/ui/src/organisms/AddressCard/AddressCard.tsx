import type { ComponentPropsWithRef } from "react";
import { Button } from "../../atoms/Button";
import { Tag } from "../../atoms/Tag";
import { cn } from "../../lib/cn";

export type AddressCardProps = Omit<ComponentPropsWithRef<"article">, "children"> & {
  label: string;
  text: string;
  kind: "fictional" | "real";
  /** The address checkout offers first. */
  isDefault?: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
  /** Shown only when the address is not already the default. */
  onSetDefault?: () => void;
};

export function AddressCard({
  label,
  text,
  kind,
  isDefault = false,
  onEdit,
  onDelete,
  onSetDefault,
  className,
  ...props
}: AddressCardProps) {
  const setDefault = isDefault ? undefined : onSetDefault;
  return (
    <article
      aria-label={label}
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 font-body",
        className,
      )}
      {...props}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-lg font-bold text-fg">{label}</h3>
        <div className="flex flex-wrap gap-2">
          {isDefault ? <Tag>Default</Tag> : null}
          <Tag>{kind === "fictional" ? "Fictional spot" : "Real address"}</Tag>
        </div>
      </div>
      <p className="break-words text-base text-fg">{text}</p>
      {onEdit || onDelete || setDefault ? (
        <div className="flex flex-wrap gap-2">
          {setDefault ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              aria-label={`Make ${label} the default`}
              onClick={setDefault}
            >
              Make default
            </Button>
          ) : null}
          {onEdit ? (
            <Button type="button" variant="secondary" size="sm" aria-label={`Edit ${label}`} onClick={onEdit}>
              Edit
            </Button>
          ) : null}
          {onDelete ? (
            <Button type="button" variant="ghost" size="sm" aria-label={`Delete ${label}`} onClick={onDelete}>
              Delete
            </Button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
