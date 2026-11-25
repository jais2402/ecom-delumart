import type { CategoryLink, ProductArtMotif } from "@delulu/ui";
import { CATEGORIES } from "../../data/seed-catalog";

/** How each category looks: the object its art draws. Presentation only. */
const STYLE: Readonly<Record<string, { motif: ProductArtMotif }>> = {
  "impossible-tech": { motif: "tech" },
  "absurd-luxury": { motif: "luxury" },
  "everyday-magic": { motif: "magic" },
  "imaginary-experiences": { motif: "experience" },
  "food-fantasies": { motif: "food" },
  "cosmic-collectibles": { motif: "cosmic" },
};

const FALLBACK = { motif: "magic" } as const;

export function motifOfCategory(slug: string): ProductArtMotif {
  return (STYLE[slug] ?? FALLBACK).motif;
}

export const CATEGORY_LINKS: readonly CategoryLink[] = CATEGORIES.map((category) => ({
  slug: category.slug,
  name: category.name,
  href: `/c/${category.slug}`,
  motif: (STYLE[category.slug] ?? FALLBACK).motif,
}));
