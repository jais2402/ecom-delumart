import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn } from "../../lib/cn";

export type AlertTone = "info" | "success" | "warning" | "danger";

const tones: Record<AlertTone, { box: string; icon: typeof Info }> = {
  info: { box: "border-info bg-info-soft", icon: Info },
  success: { box: "border-success bg-success-soft", icon: CheckCircle2 },
  warning: { box: "border-warning bg-warning-soft", icon: AlertTriangle },
  danger: { box: "border-danger bg-danger-soft", icon: XCircle },
};

export type AlertProps = Omit<ComponentPropsWithRef<"div">, "title" | "role"> & {
  tone?: AlertTone;
  title?: ReactNode;
};

export function Alert({ tone = "info", title, className, children, ...props }: AlertProps) {
  const { box, icon: Glyph } = tones[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn("flex gap-3 rounded-md border p-3 font-body text-fg", box, className)}
      {...props}
    >
      <Glyph aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
      <div className="min-w-0 text-sm">
        {title ? <p className="font-bold">{title}</p> : null}
        {children ? <div>{children}</div> : null}
      </div>
    </div>
  );
}
