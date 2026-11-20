import type { LucideIcon, LucideProps } from "lucide-react";

export type IconProps = Omit<LucideProps, "ref"> & {
  icon: LucideIcon;
  /** Provide a label only when the icon carries meaning on its own. */
  label?: string;
};

/** Wrapper for lucide icons: decorative (aria-hidden) unless labelled. */
export function Icon({ icon: Glyph, label, size = 20, ...props }: IconProps) {
  if (label) {
    return <Glyph role="img" aria-label={label} size={size} {...props} />;
  }
  return <Glyph aria-hidden="true" size={size} {...props} />;
}
