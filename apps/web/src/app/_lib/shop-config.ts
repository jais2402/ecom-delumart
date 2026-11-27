/**
 * Tunable numbers of the storefront's browsing features (CLAUDE.md invariant 10: no literals in
 * feature code). Presentation only: none of these is money or an authorisation.
 */
export const SHOP_CONFIG = {
  suggest: {
    /** Characters the shopper types before suggestions are looked for. */
    minChars: 2,
    /** Wait after the last key before looking. */
    debounceMs: 200,
    /** Products and departments in the list. */
    maxProducts: 6,
    maxCategories: 2,
  },
  subNav: {
    /** Plain department links after the pills, from 1024px. */
    textLinks: 4,
  },
  recent: {
    /** Product ids remembered in this browser. */
    remember: 12,
    /** Cards in the "Recently viewed" rail. */
    railCount: 12,
  },
  saved: {
    /** Cards in the home page's "Saved for later" rail. */
    railCount: 12,
  },
  deals: {
    /** Shops whose public coupons the Deals page reads (one public request each). */
    maxShops: 40,
    /** Shop coupon requests in flight at once. */
    concurrency: 6,
  },
} as const;
