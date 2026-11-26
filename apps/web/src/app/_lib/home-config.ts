/**
 * Tunable numbers of the home page (CLAUDE.md invariant 10: no literals in feature code). Kept
 * apart from the server configuration because the browser also derives the rails when the page
 * was built without products. There are no money thresholds: the "cheap" and "expensive" rails
 * are the cheapest and dearest products, so only counts are needed.
 */
export const HOME_CONFIG = {
  hero: {
    /** Featured products in the hero carousel: the dearest, those with a photo first. */
    slideCount: 4,
  },
  topPicks: {
    /** Products in each tab of "Top picks". */
    perTab: 10,
  },
  rails: {
    /** Products in "Lowest prices" (the cheapest). */
    pocketChangeCount: 10,
    /** Products in "Premium picks" (the dearest after the hero's). */
    bigFlexCount: 10,
  },
} as const;
