import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DomainError } from "../errors/index";
import {
  AMOUNT_BUCKETS,
  ANALYTICS_EVENT_NAMES,
  amountBucket,
  BROWSER_EVENT_NAMES,
  DEVICE_CLASSES,
  deviceClassOf,
  ITEM_COUNT_MAX,
  itemCount,
  PLACE_LABEL_MAX,
  parsePlace,
  QUERY_LENGTH_BUCKETS,
  queryLengthBucket,
  RANGE_MAX_DAYS,
  RESULT_COUNT_BUCKETS,
  resultCountBucket,
  SERVER_EVENT_NAMES,
  validateDateRange,
} from "./index";

describe("analytics event names", () => {
  it("R16.5: browser events and server events are disjoint and together the whole allow-list", () => {
    const browser = new Set<string>(BROWSER_EVENT_NAMES);
    for (const n of SERVER_EVENT_NAMES) expect(browser.has(n)).toBe(false);
    expect([...BROWSER_EVENT_NAMES, ...SERVER_EVENT_NAMES].sort()).toEqual([...ANALYTICS_EVENT_NAMES].sort());
    expect([...SERVER_EVENT_NAMES].sort()).toEqual(
      [
        "creator_unlock",
        "listing_published",
        "purchase",
        "shop_registered",
        "sign_up",
        // ratings and reviews (decisions.md #14): recorded by the server, never by a browser
        "review_submitted",
        "review_hidden",
        // Super Admin configuration changes (decisions.md #15): written by the database when a
        // delayed action runs; no props, no user id, no values
        "console_config_changed",
      ].sort(),
    );
  });
});

describe("buckets never carry the exact value", () => {
  it("result counts fall in exactly one bucket (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), (n) => {
        expect(RESULT_COUNT_BUCKETS).toContain(resultCountBucket(n));
      }),
    );
    expect(resultCountBucket(0)).toBe("0");
    expect(resultCountBucket(1)).toBe("1-5");
    expect(resultCountBucket(5)).toBe("1-5");
    expect(resultCountBucket(6)).toBe("6-20");
    expect(resultCountBucket(21)).toBe("21+");
  });

  it("query lengths fall in exactly one bucket; the query itself is never an input (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), (n) => {
        expect(QUERY_LENGTH_BUCKETS).toContain(queryLengthBucket(n));
      }),
    );
    expect(queryLengthBucket(0)).toBe("0");
    expect(queryLengthBucket(3)).toBe("1-3");
    expect(queryLengthBucket(10)).toBe("4-10");
    expect(queryLengthBucket(30)).toBe("11-30");
    expect(queryLengthBucket(31)).toBe("31+");
  });

  it("amounts are bucketed from bigint paise, monotonically (property)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        (a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          expect(AMOUNT_BUCKETS.indexOf(amountBucket(lo))).toBeLessThanOrEqual(
            AMOUNT_BUCKETS.indexOf(amountBucket(hi)),
          );
        },
      ),
    );
    expect(amountBucket(99_999n)).toBe("lt_1k");
    expect(amountBucket(100_000n)).toBe("1k_10k");
    expect(amountBucket(10_000_000_000n)).toBe("1cr_plus");
    expect(() => amountBucket(-1n)).toThrow(DomainError);
  });

  it("item counts are clamped to 1..max", () => {
    expect(itemCount(0)).toBe(1);
    expect(itemCount(3)).toBe(3);
    expect(itemCount(10_000)).toBe(ITEM_COUNT_MAX);
  });
});

describe("deviceClassOf", () => {
  it("returns only a class, for any input (property)", () => {
    fc.assert(
      fc.property(fc.option(fc.string({ maxLength: 600 }), { nil: null }), (ua) => {
        expect(DEVICE_CLASSES).toContain(deviceClassOf(ua));
      }),
    );
  });

  it("classifies common agents", () => {
    expect(deviceClassOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148")).toBe(
      "mobile",
    );
    expect(deviceClassOf("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120 Mobile Safari/537.36")).toBe(
      "mobile",
    );
    expect(deviceClassOf("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)")).toBe("tablet");
    expect(deviceClassOf("Mozilla/5.0 (Linux; Android 13; SM-X200) Chrome/120 Safari/537.36")).toBe("tablet");
    expect(deviceClassOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120")).toBe("desktop");
    expect(deviceClassOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBe("desktop");
    expect(deviceClassOf("curl/8.0")).toBe("unknown");
    expect(deviceClassOf(null)).toBe("unknown");
  });
});

describe("parsePlace (R7.1: labels from the hosting edge, validated and capped)", () => {
  it("accepts an ISO country, a region code and a URL-encoded city", () => {
    expect(parsePlace({ country: "IN", region: "MH", city: "Navi%20Mumbai" })).toEqual({
      country: "IN",
      region: "MH",
      city: "Navi Mumbai",
    });
    expect(parsePlace({ country: "in", region: "ka", city: "Bengaluru" })).toEqual({
      country: "IN",
      region: "KA",
      city: "Bengaluru",
    });
    expect(parsePlace({ country: "DE", region: "BY", city: "M%C3%BCnchen" })).toEqual({
      country: "DE",
      region: "BY",
      city: "München",
    });
  });

  it("anything unresolvable is 'ZZ' with no region or city", () => {
    for (const country of [null, "", "XX1", "USA", "1A", "ZZ", "T1", "../"]) {
      expect(parsePlace({ country, region: "MH", city: "Pune" })).toEqual({
        country: "ZZ",
        region: null,
        city: null,
      });
    }
  });

  it("hostile region and city values are dropped, never stored", () => {
    const hostile = [
      "%ZZ",
      "%00",
      "Pune%0AEvil",
      "<script>",
      "a|b",
      "Pune\u0000",
      "x".repeat(PLACE_LABEL_MAX + 1),
      "%E0%A4%A",
      "' OR 1=1 --",
      "‮evil",
    ];
    for (const value of hostile) {
      const place = parsePlace({ country: "IN", region: value, city: value });
      expect(place.country).toBe("IN");
      expect(place.region).toBeNull();
      expect(place.city).toBeNull();
    }
    // a city without a region is kept under an unknown region
    expect(parsePlace({ country: "IN", region: null, city: "Pune" })).toEqual({
      country: "IN",
      region: null,
      city: "Pune",
    });
  });

  it("eighth review, minor 5: a region is only an ISO 3166-2 subdivision code part (what the edge sends); free text is dropped", () => {
    for (const ok of ["MH", "ka", "BY", "TG", "01", "13", "ENG", "N"]) {
      expect(parsePlace({ country: "IN", region: ok, city: null }).region, ok).toBe(ok.toUpperCase());
    }
    for (const bad of ["Maharashtra", "MHX1", "M H", "Karnataka state", "M-H", "hello world", "ÉÉ"]) {
      expect(parsePlace({ country: "IN", region: bad, city: null }).region, bad).toBeNull();
    }
  });

  it("eighth review, minor 5: a city is letters of any script, spaces, apostrophes, hyphens and dots only — no digits or symbols", () => {
    for (const ok of [
      "Navi%20Mumbai",
      "S%C3%A3o%20Paulo",
      "%E0%A4%AE%E0%A5%81%E0%A4%82%E0%A4%AC%E0%A4%88",
      "O'Fallon",
      "St.%20Louis",
      "Winston-Salem",
      "%E5%8C%97%E4%BA%AC",
    ]) {
      expect(parsePlace({ country: "IN", region: null, city: ok }).city, ok).toBe(decodeURIComponent(ok));
    }
    for (const bad of [
      "Pune1",
      "Pune 411001",
      "Sector 17",
      "Mumbai,",
      "Delhi (NCR)",
      "call me 98765",
      "a@b.example",
      "%E0%A5%A7%E0%A5%A8",
      "%F0%9F%98%80town",
      "%E2%84%82ity",
      "x".repeat(PLACE_LABEL_MAX + 1),
    ]) {
      expect(parsePlace({ country: "IN", region: null, city: bad }).city, bad).toBeNull();
    }
  });

  it("any input yields a valid place (property)", () => {
    fc.assert(
      fc.property(
        fc.option(fc.string(), { nil: null }),
        fc.option(fc.string(), { nil: null }),
        fc.option(fc.string(), { nil: null }),
        (country, region, city) => {
          const p = parsePlace({ country, region, city });
          expect(p.country).toMatch(/^[A-Z]{2}$/);
          for (const label of [p.region, p.city]) {
            if (label === null) continue;
            expect(label.length).toBeGreaterThan(0);
            expect(label.length).toBeLessThanOrEqual(PLACE_LABEL_MAX);
            expect(label).not.toMatch(/[|<>"\\\p{Cc}]/u);
          }
          if (p.region !== null) expect(p.region).toMatch(/^[A-Z0-9]{1,3}$/);
          if (p.city !== null) expect(p.city).not.toMatch(/\p{N}/u);
          if (p.country === "ZZ") expect([p.region, p.city]).toEqual([null, null]);
        },
      ),
    );
  });
});

describe("validateDateRange", () => {
  it("accepts from <= to within the limit and returns the day count", () => {
    expect(validateDateRange("2026-01-01", "2026-01-01")).toEqual({
      from: "2026-01-01",
      to: "2026-01-01",
      days: 1,
    });
    expect(validateDateRange("2025-01-01", "2025-12-31").days).toBe(365);
    expect(validateDateRange("2024-01-01", "2024-12-31").days).toBe(RANGE_MAX_DAYS);
  });

  it("refuses reversed, too long and malformed ranges with VALIDATION_FAILED", () => {
    for (const [from, to] of [
      ["2026-02-02", "2026-02-01"],
      ["2024-01-01", "2025-01-01"],
      ["2026-02-30", "2026-03-01"],
      ["2026-1-1", "2026-01-02"],
      ["yesterday", "2026-01-02"],
    ] as const) {
      try {
        validateDateRange(from, to);
        expect.unreachable(`${from}..${to}`);
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError);
        expect((error as DomainError).code).toBe("VALIDATION_FAILED");
      }
    }
  });
});
