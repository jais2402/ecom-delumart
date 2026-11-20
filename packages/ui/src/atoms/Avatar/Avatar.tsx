import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";

export type AvatarProps = Omit<ComponentPropsWithRef<"span">, "children"> & {
  /** Person or shop name; used for the accessible name and the initials fallback. */
  name: string;
  src?: string;
  size?: "sm" | "md" | "lg";
};

const sizes = { sm: "size-8 text-xs", md: "size-10 text-sm", lg: "size-14 text-lg" };

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

export function Avatar({ name, src, size = "md", className, ...props }: AvatarProps) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-pill bg-action-soft font-display font-bold text-fg",
        sizes[size],
        className,
      )}
      {...props}
    >
      {src ? (
        <img src={src} alt={name} className="size-full object-cover" />
      ) : (
        <span role="img" aria-label={name}>
          {initialsOf(name)}
        </span>
      )}
    </span>
  );
}
