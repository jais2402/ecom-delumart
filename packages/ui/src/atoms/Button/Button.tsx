import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";

export const buttonVariants = cva(
  "inline-flex min-h-touch items-center justify-center gap-2 rounded-pill font-body font-semibold transition-colors duration-fast disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-action text-fg-on-action hover:bg-action-hover",
        secondary: "border border-fg bg-surface text-fg hover:bg-action-soft",
        ghost: "bg-transparent text-fg hover:bg-action-soft",
        danger: "bg-danger text-fg-on-action hover:opacity-90",
        cta: "bg-cta text-fg-on-cta hover:bg-cta-hover",
        ctaStrong: "bg-cta-strong text-fg-on-cta-strong hover:bg-cta-strong-hover",
      },
      size: {
        sm: "px-3 text-sm",
        md: "px-4 text-base",
        lg: "px-6 text-lg",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export type ButtonProps = ComponentPropsWithRef<"button"> &
  VariantProps<typeof buttonVariants> & {
    loading?: boolean;
    asChild?: boolean;
  };

export function Button({
  className,
  variant,
  size,
  loading = false,
  asChild = false,
  disabled,
  children,
  type,
  ...props
}: ButtonProps) {
  const classes = cn(buttonVariants({ variant, size }), className);
  if (asChild) {
    return (
      <Slot className={classes} aria-busy={loading || undefined} {...props}>
        {children}
      </Slot>
    );
  }
  return (
    <button
      type={type ?? "button"}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
      ) : null}
      {children}
    </button>
  );
}
