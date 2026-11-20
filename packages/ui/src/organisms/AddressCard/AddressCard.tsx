import type { ComponentPropsWithRef } from "react";
import { Button } from "../../atoms/Button";
import { Tag } from "../../atoms/Tag";
import { cn } from "../../lib/cn";

export type AddressCardProps = Omit<ComponentPropsWithRef<"article">, "children"> & {
  label: string;
  text: string;
  kind: "fictional" | "real";
  onEdit?: () => void;
  onDelete?: () => void;
};

export function AddressCard({ label, text, kind, onEdit, onDelete, className, ...props }: AddressCardProps) {
  return (
    <article
      aria-label={label}
      className={cn("flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 font-body", className)}
      {...props}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-lg font-bold text-fg">{label}</h3>
        <Tag>{kind === "fictional" ? "Fictional spot" : "Real address"}</Tag>
      </div>
      <p className="text-base text-fg">{text}</p>
      {onEdit || onDelete ? (
        <div className="flex flex-wrap gap-2">
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
