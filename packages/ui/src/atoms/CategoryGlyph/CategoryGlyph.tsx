import { Cpu, Gem, IceCreamCone, Orbit, Ticket, WandSparkles } from "lucide-react";
import { Icon, type IconProps } from "../Icon";
import { ART_MOTIFS, type ProductArtMotif } from "../ProductArt/art-motifs";

const glyphs = {
  tech: Cpu,
  luxury: Gem,
  magic: WandSparkles,
  experience: Ticket,
  food: IceCreamCone,
  cosmic: Orbit,
} as const satisfies Record<ProductArtMotif, IconProps["icon"]>;

export type CategoryGlyphProps = Omit<IconProps, "icon"> & {
  motif: ProductArtMotif;
};

/** The small line icon for a category, matching the object ProductArt draws for it. Decorative unless labelled. */
export function CategoryGlyph({ motif, ...props }: CategoryGlyphProps) {
  return <Icon icon={glyphs[motif] ?? glyphs[ART_MOTIFS[0]]} {...props} />;
}
