import type { ReactNode } from "react";

/** The six illustration families. Each product category maps to one; see ProductArt. */
export const ART_MOTIFS = ["tech", "luxury", "magic", "experience", "food", "cosmic"] as const;
export type ProductArtMotif = (typeof ART_MOTIFS)[number];

export type MotifColours = {
  /** Main body of the object. */
  body: string;
  /** Second colour for details. */
  accent: string;
  /** Outline and fine detail. */
  ink: string;
};

/**
 * One clean object per motif, drawn around (0, 0) in a box about 56 units wide, like a product
 * photograph: flat shapes, no sparkles. Passing the same colour for every field draws a flat
 * silhouette.
 */
export function drawMotif(motif: ProductArtMotif, c: MotifColours): ReactNode {
  switch (motif) {
    case "tech":
      return (
        <>
          <rect x="-16" y="-28" width="32" height="56" rx="6" fill={c.ink} />
          <rect x="-13" y="-24" width="26" height="44" rx="3" fill={c.accent} />
          <path d="M-13,-8 L-1,-24 L6,-24 L-13,2Z" fill={c.body} opacity="0.3" />
          <circle cx="0" cy="24" r="1.8" fill={c.body} />
        </>
      );
    case "luxury":
      return (
        <>
          <polygon points="-26,-8 -15,-24 15,-24 26,-8 0,27" fill={c.body} />
          <polygon points="-26,-8 26,-8 15,-24 -15,-24" fill={c.accent} opacity="0.55" />
          <path
            d="M-26,-8 L0,27 L26,-8 M-9,-8 L0,27 L9,-8 M-15,-24 L-9,-8 M15,-24 L9,-8"
            fill="none"
            stroke={c.ink}
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </>
      );
    case "magic":
      return (
        <>
          <circle cx="0" cy="-10" r="18" fill={c.body} />
          <path d="M-8,4 Q-10,14 -7,18 H7 Q10,14 8,4Z" fill={c.body} />
          <path
            d="M-4,-4 L0,4 L4,-4"
            fill="none"
            stroke={c.accent}
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <rect x="-8" y="18" width="16" height="4" rx="1" fill={c.ink} />
          <rect x="-6" y="23" width="12" height="4" rx="1.5" fill={c.ink} />
        </>
      );
    case "experience":
      return (
        <g transform="rotate(-8)">
          <path
            d="M-28,-12 a4,4 0 0 1 4,-4 H24 a4,4 0 0 1 4,4 V-5 a5,5 0 0 0 0,10 V12 a4,4 0 0 1 -4,4 H-24 a4,4 0 0 1 -4,-4 V5 a5,5 0 0 0 0,-10Z"
            fill={c.body}
          />
          <path d="M10,-13 V13" stroke={c.ink} strokeWidth="1.6" strokeDasharray="3 3.4" fill="none" />
          <circle cx="-9" cy="0" r="8" fill={c.accent} />
          <path d="M16,-6 H23 M16,0 H23 M16,6 H21" stroke={c.ink} strokeWidth="2.2" strokeLinecap="round" />
        </g>
      );
    case "food":
      return (
        <>
          <polygon points="-13,2 13,2 0,32" fill={c.accent} />
          <path d="M-9,8 L5,24 M-3,5 L9,18 M3,5 L-5,15" stroke={c.ink} strokeWidth="1.2" opacity="0.5" />
          <ellipse cx="0" cy="0" rx="17" ry="9" fill={c.body} />
          <circle cx="0" cy="-12" r="13" fill={c.body} />
          <circle cx="0" cy="-27" r="4.4" fill={c.accent} />
        </>
      );
    case "cosmic":
      return (
        <>
          <g transform="rotate(-22)">
            <path d="M-30,0 A30,8 0 0 1 30,0" fill="none" stroke={c.accent} strokeWidth="4" />
          </g>
          <circle cx="0" cy="0" r="18" fill={c.body} />
          <path
            d="M-17,-6 Q0,-12 17,-6 M-18,5 Q0,0 18,5"
            fill="none"
            stroke={c.accent}
            strokeWidth="1.8"
            opacity="0.6"
          />
          <g transform="rotate(-22)">
            <path d="M-30,0 A30,8 0 0 0 30,0" fill="none" stroke={c.accent} strokeWidth="4" />
          </g>
        </>
      );
  }
}
