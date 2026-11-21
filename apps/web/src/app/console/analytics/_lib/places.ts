import type { PlaceItem, PlaceLevel } from "./types";

export const UNKNOWN_COUNTRY = "ZZ";
export const OTHER = "Other";
const OTHER_LABEL = "Other (small places combined)";

let names: Intl.DisplayNames | null | undefined;
function countryName(code: string): string {
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      names = null;
    }
  }
  try {
    return names?.of(code) ?? code;
  } catch {
    return code;
  }
}

/** The label of a place at the given level, with the API's markers turned into words. */
export function placeLabel(item: PlaceItem, level: PlaceLevel): string {
  if (level === "country") {
    if (item.country === UNKNOWN_COUNTRY) return "Unknown location";
    if (item.country === OTHER) return OTHER_LABEL;
    return countryName(item.country);
  }
  const value = level === "region" ? item.region : item.city;
  if (value === null || value === "") return "Unknown";
  if (value === OTHER) return OTHER_LABEL;
  return value;
}

/** The value a drill-down passes on, or null when the row cannot be opened (unknown or folded places). */
export function placeKey(item: PlaceItem, level: PlaceLevel): string | null {
  if (level === "country")
    return item.country === UNKNOWN_COUNTRY || item.country === OTHER ? null : item.country;
  if (level === "region")
    return item.region === null || item.region === OTHER || item.region === "" ? null : item.region;
  return null;
}
