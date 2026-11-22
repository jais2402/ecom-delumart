/** Bodies of /api/v1/admin/analytics/*. Money is a decimal string of integer paise; days are UTC YYYY-MM-DD. */

export type Totals = {
  visitors: number;
  trafficDays: number;
  signUps: number;
  orders: number;
  spendPaise: string;
  averageOrderValuePaise: string | null;
  creatorUnlocks: number;
  shopsRegistered: number;
  listingsPublished: number;
};

export type OverviewResponse = {
  from: string;
  to: string;
  days: number;
  previousFrom: string;
  previousTo: string;
  current: Totals;
  previous: Totals;
  asOf: string;
  trafficComputedAt: string | null;
};

export const METRICS = [
  { value: "visitors", label: "Daily visitors (summed)" },
  { value: "page_views", label: "Page views" },
  { value: "searches", label: "Searches" },
  { value: "product_views", label: "Product views" },
  { value: "cart_adds", label: "Cart adds" },
  { value: "checkout_starts", label: "Checkout starts" },
  { value: "sign_ups", label: "Sign-ups" },
  { value: "orders", label: "Orders" },
  { value: "spend", label: "Spend (fictional money)" },
  { value: "creator_unlocks", label: "Creator unlocks" },
  { value: "shops_registered", label: "Shops registered" },
  { value: "listings_published", label: "Listings published" },
] as const;

export type Metric = (typeof METRICS)[number]["value"];

export function isMetric(value: string | null): value is Metric {
  return METRICS.some((m) => m.value === value);
}

export type TimeseriesResponse = {
  metric: Metric;
  from: string;
  to: string;
  days: number;
  unit: "count" | "paise";
  source: "events" | "records";
  points: { day: string; value: string | null }[];
  asOf: string;
};

export type FunnelStepKey = "visitors" | "product_views" | "cart_adds" | "checkout_starts" | "purchases";

export type FunnelResponse = {
  from: string;
  to: string;
  days: number;
  /** `visitors`: daily visitors (summed); for the purchases step (unit "events"), purchases. */
  steps: {
    step: FunnelStepKey;
    visitors: number;
    unit: "visitors" | "events";
    conversionFromPrevious: number | null;
  }[];
  overallConversion: number | null;
  trafficDays: number;
  asOf: string;
};

export type PlaceLevel = "country" | "region" | "city";

export type PlaceItem = {
  country: string;
  region: string | null;
  city: string | null;
  /** Null for the suppressed "Other" row (below the minimum even after merging). */
  visitors: number | null;
  /** Also null on a shown row when between 1 and the cell minimum. */
  signUps: number | null;
  purchases: number | null;
  suppressed: boolean;
};

export type PlacesResponse = {
  level: PlaceLevel;
  country: string | null;
  region: string | null;
  from: string;
  to: string;
  days: number;
  minVisitors: number;
  /** Sign-up and purchase cells below this (and above 0) are null. */
  minCellCount: number;
  items: PlaceItem[];
  trafficDays: number;
  asOf: string;
};

export type TopKind = "product" | "company" | "category";

type Shop = { name: string; handle: string } | null;
export type TopProduct = {
  productId: string;
  name: string;
  category: string;
  shop: Shop;
  orders: number;
  units: number;
  spendPaise: string;
};
export type TopCompany = {
  companyId: string | null;
  shop: Shop;
  orders: number;
  units: number;
  spendPaise: string;
};
export type TopCategory = { category: string; orders: number; units: number; spendPaise: string };

export type TopResponse = {
  kind: TopKind;
  from: string;
  to: string;
  days: number;
  limit: number;
  asOf: string;
  items: (TopProduct | TopCompany | TopCategory)[];
};
