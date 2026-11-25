import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";
import { ART_MOTIFS, drawMotif, type ProductArtMotif } from "./art-motifs";

export { ART_MOTIFS, type ProductArtMotif } from "./art-motifs";

export type ProductArtProps = Omit<ComponentPropsWithRef<"svg">, "children" | "role" | "aria-label"> & {
  /** Base hue, 0 to 359. */
  hue: number;
  /** Any string; the same hue and seed always draw the same picture. */
  seed: string;
  /** Describes the picture. Pass an empty string when the art is purely decorative. */
  alt: string;
  /** The object drawn in the middle, normally from the product's category. Chosen from the seed when omitted. */
  motif?: ProductArtMotif;
};

/** FNV-1a hash of the seed, then a small mulberry32 generator. Deterministic across server and client. */
function makeRandom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const wrapHue = (value: number): number => ((Math.round(value) % 360) + 360) % 360;

/** The motif a seed gets when the caller names none. */
export function motifFromSeed(seed: string): ProductArtMotif {
  const index = Math.floor(makeRandom(`${seed}:motif`)() * ART_MOTIFS.length);
  return ART_MOTIFS[index] ?? "magic";
}

/**
 * Generated product picture: one clean object for the category on a plain light backdrop with a
 * soft ground shadow, like a product photograph. Always square, and always the same for the same
 * hue and seed; the seed nudges the object's tilt, size, position and second colour.
 */
export function ProductArt({ hue, seed, alt, motif, className, ...props }: ProductArtProps) {
  const rand = makeRandom(`${seed}:${hue}:layout`);
  const h = wrapHue(hue);
  const tilt = Math.round((rand() - 0.5) * 10);
  const scale = 1.35 + rand() * 0.2;
  const dx = Math.round((rand() - 0.5) * 6);
  const accentHue = wrapHue(h + Math.round((rand() - 0.5) * 50));
  const chosen = motif ?? motifFromSeed(seed);
  const colours = {
    body: `hsl(${h} 16% 84%)`,
    accent: `hsl(${accentHue} 52% 52%)`,
    ink: `hsl(${h} 18% 24%)`,
  };
  const a11y = alt ? { role: "img" as const, "aria-label": alt } : { "aria-hidden": true as const };
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: the name comes from aria-label, or the art is aria-hidden when decorative
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid slice"
      className={cn("block aspect-square w-full overflow-hidden rounded-md bg-surface-raised", className)}
      {...a11y}
      {...props}
    >
      <ellipse cx={50 + dx} cy="84" rx="25" ry="3.6" fill="black" opacity="0.1" />
      <ellipse cx={50 + dx} cy="84" rx="15" ry="2.2" fill="black" opacity="0.12" />
      <g transform={`translate(${50 + dx} 52) rotate(${tilt}) scale(${scale.toFixed(2)})`}>
        {drawMotif(chosen, colours)}
      </g>
    </svg>
  );
}
