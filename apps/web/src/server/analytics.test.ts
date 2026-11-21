import { randomBytes } from "node:crypto";
import fc from "fast-check";
import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setTestEnv } from "../../tests/helpers/app";
import { analyticsFailures, declinesTracking, placeOf, track, utcDay, visitorKey } from "./analytics";
import { PEER_HEADER, peerStampValue } from "./client-address";

const vercel = { geoSource: "vercel", devGeo: null } as const;
const headersOf = (h: Record<string, string>) => new Headers(h);

describe("placeOf (R7.1: the edge's approximate place)", () => {
  it("reads the Vercel headers, URL-decoded and validated", () => {
    expect(
      placeOf(
        headersOf({
          "x-vercel-ip-country": "IN",
          "x-vercel-ip-country-region": "MH",
          "x-vercel-ip-city": "Navi%20Mumbai",
        }),
        vercel,
      ),
    ).toEqual({ country: "IN", region: "MH", city: "Navi Mumbai" });
    expect(placeOf(headersOf({}), vercel)).toEqual({ country: "ZZ", region: null, city: null });
  });

  it("drops hostile values: never stored, never an error", () => {
    const hostile = [
      "%3Cscript%3Ealert(1)%3C%2Fscript%3E",
      "Pune%0D%0ASet-Cookie:%20x=1",
      "%E0%A4",
      "a%7Cb",
      "x".repeat(400),
      "%00",
      "Robert'); DROP TABLE analytics.event;--",
    ];
    for (const value of hostile) {
      const p = placeOf(
        headersOf({
          "x-vercel-ip-country": "IN",
          "x-vercel-ip-country-region": value,
          "x-vercel-ip-city": value,
        }),
        vercel,
      );
      expect(p).toEqual({ country: "IN", region: null, city: null });
    }
    expect(placeOf(headersOf({ "x-vercel-ip-country": "IND" }), vercel).country).toBe("ZZ");
    expect(placeOf(headersOf({ "x-vercel-ip-country": "<i>" }), vercel).country).toBe("ZZ");
  });

  it("ignores every geo header unless the host is configured to set them (a client cannot inject a place)", () => {
    const h = headersOf({ "x-vercel-ip-country": "US", "x-vercel-ip-city": "Austin" });
    expect(placeOf(h, { geoSource: "none", devGeo: null })).toEqual({
      country: "ZZ",
      region: null,
      city: null,
    });
  });

  it("DEV_GEO fixes the place in development, whatever the headers say", () => {
    const h = headersOf({ "x-vercel-ip-country": "US" });
    expect(
      placeOf(h, { geoSource: "vercel", devGeo: { country: "IN", region: "KA", city: "Bengaluru" } }),
    ).toEqual({
      country: "IN",
      region: "KA",
      city: "Bengaluru",
    });
  });
});

describe("visitorKey (R16.5: daily-rotating, keyed, never the address or user agent)", () => {
  const key = randomBytes(32);
  const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)";

  it("is 16 bytes, stable within a UTC day and different the next day (property)", () => {
    fc.assert(
      fc.property(fc.ipV4(), fc.string({ maxLength: 200 }), (address, agent) => {
        const a = visitorKey(key, "2026-11-20", address, agent);
        expect(a.length).toBe(16);
        expect(visitorKey(key, "2026-11-20", address, agent)).toEqual(a);
        expect(visitorKey(key, "2026-11-21", address, agent)).not.toEqual(a);
      }),
    );
  });

  it("groups an IPv6 client by its /64 and separates /64s, browsers and keys", () => {
    const a = visitorKey(key, "2026-11-20", "2001:db8:1:2::1", ua);
    expect(visitorKey(key, "2026-11-20", "2001:db8:1:2:ffff::9", ua)).toEqual(a);
    expect(visitorKey(key, "2026-11-20", "2001:db8:1:3::1", ua)).not.toEqual(a);
    expect(visitorKey(key, "2026-11-20", "2001:db8:1:2::1", `${ua} Firefox`)).not.toEqual(a);
    expect(visitorKey(randomBytes(32), "2026-11-20", "2001:db8:1:2::1", ua)).not.toEqual(a);
    expect(a.toString("hex")).not.toContain(Buffer.from("2001:db8").toString("hex"));
  });

  it("the day comes from the injected clock, in UTC", () => {
    expect(utcDay(new Date("2026-11-20T23:59:59+05:30"))).toBe("2026-11-20");
    expect(utcDay(new Date("2026-11-21T04:00:00+05:30"))).toBe("2026-11-20");
    expect(utcDay(new Date("2026-11-21T06:00:00+05:30"))).toBe("2026-11-21");
  });
});

describe("declinesTracking", () => {
  it("honours Sec-GPC: 1 and DNT: 1 only", () => {
    expect(declinesTracking(headersOf({ "sec-gpc": "1" }))).toBe(true);
    expect(declinesTracking(headersOf({ dnt: "1" }))).toBe(true);
    expect(declinesTracking(headersOf({ dnt: "0" }))).toBe(false);
    expect(declinesTracking(headersOf({}))).toBe(false);
  });
});

describe("track never fails the request", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a database failure is caught, counted and logged by code only — no address, agent or place", async () => {
    setTestEnv("postgres://nobody:nothing@127.0.0.1:1/none", { GEO_SOURCE: "vercel" });
    const logged: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    const failing = {
      connect: () =>
        Promise.reject(
          Object.assign(new Error("connect to 203.0.113.9 failed for Mozilla"), { code: "ECONNREFUSED" }),
        ),
    } as unknown as pg.Pool;
    const request = new Request("https://app.delulu.test/p/1", {
      headers: {
        [PEER_HEADER]: peerStampValue("203.0.113.9"),
        "user-agent": "Mozilla/5.0 (Secret Agent)",
        "x-vercel-ip-country": "IN",
        "x-vercel-ip-city": "Pune",
      },
    });
    const before = analyticsFailures();
    expect(
      await track(request, "page_view", {}, { surface: "shop", authSessionId: null, pool: failing }),
    ).toBe(false);
    expect(analyticsFailures()).toBe(before + 1);
    const text = JSON.stringify(logged);
    expect(text).toContain("ECONNREFUSED");
    for (const secret of ["203.0.113.9", "Secret Agent", "Pune", "Mozilla"])
      expect(text).not.toContain(secret);
  });

  it("records nothing without an ANALYTICS_KEY, or when the client sends Sec-GPC", async () => {
    const touched = vi.fn();
    const pool = { connect: touched } as unknown as pg.Pool;
    setTestEnv("postgres://nobody:nothing@127.0.0.1:1/none", { ANALYTICS_KEY: undefined });
    expect(
      await track(
        new Request("https://x.test/"),
        "page_view",
        {},
        { surface: "shop", authSessionId: null, pool },
      ),
    ).toBe(false);
    setTestEnv("postgres://nobody:nothing@127.0.0.1:1/none");
    const gpc = new Request("https://x.test/", { headers: { "sec-gpc": "1" } });
    expect(await track(gpc, "page_view", {}, { surface: "shop", authSessionId: null, pool })).toBe(false);
    expect(touched).not.toHaveBeenCalled();
  });
});
