/**
 * Tunable numbers of the home page (CLAUDE.md invariant 10: no literals in feature code). Kept
 * apart from the server configuration because the browser also derives the rails when the page
 * was built without products. There are no money thresholds: the "cheap" and "expensive" rails
 * are the cheapest and dearest products, so only counts are needed.
 */
export const HOME_CONFIG = {
  rails: {
    /** Products in "Pocket change" (the cheapest). */
    pocketChangeCount: 10,
    /** Products in "Big flex" (the dearest). */
    bigFlexCount: 10,
    /** Products in each category's rail. */
    categoryRailCount: 10,
    /** A category gets a rail only with at least this many products. */
    categoryRailMinimum: 3,
  },
  /** Product-art tiles floating in the hero and creator band, by catalogue position. */
  stickers: { heroCount: 3, creatorCount: 3 },
} as const;
