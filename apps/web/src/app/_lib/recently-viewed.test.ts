import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pushRecent, RECENT_KEY, readRecent, recordViewed } from "./recently-viewed";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

describe("pushRecent", () => {
  it("puts the newest first, moves a repeat to the front and keeps at most max", () => {
    expect(pushRecent([A, B], C, 3)).toEqual([C, A, B]);
    expect(pushRecent([A, B, C], B, 3)).toEqual([B, A, C]);
    expect(pushRecent([A, B, C], "44444444-4444-4444-8444-444444444444", 3)).toHaveLength(3);
  });
});

describe("recently viewed storage", () => {
  const data = new Map<string, string>();
  const nav: { doNotTrack: string | null } = { doNotTrack: null };
  beforeEach(() => {
    data.clear();
    nav.doNotTrack = null;
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    });
    vi.stubGlobal("window", { navigator: nav });
  });
  afterEach(() => vi.unstubAllGlobals());
  it("remembers ids only, newest first, and ignores anything that is not an id", () => {
    recordViewed(A);
    recordViewed(B);
    recordViewed("not an id");
    expect(readRecent()).toEqual([B, A]);
    expect(data.get(RECENT_KEY)).toBe(JSON.stringify([B, A]));
  });
  it("stores and shows nothing when the browser asks not to be tracked", () => {
    recordViewed(A);
    nav.doNotTrack = "1";
    recordViewed(B);
    expect(readRecent()).toEqual([]);
    nav.doNotTrack = null;
    expect(readRecent()).toEqual([A]);
  });
});
