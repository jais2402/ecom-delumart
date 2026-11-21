import { describe, expect, it, vi } from "vitest";
import { EVENTS_PATH, trackClient } from "./analytics";

describe("trackClient (R16.5)", () => {
  it("sends one same-origin beacon with only the name, surface and props", () => {
    const sendBeacon = vi.fn(() => true);
    const fetch = vi.fn();
    trackClient("search", { resultCount: 3, queryLength: 9 }, "shop", { navigator: { sendBeacon }, fetch });
    expect(sendBeacon).toHaveBeenCalledWith(
      EVENTS_PATH,
      JSON.stringify({ name: "search", surface: "shop", props: { resultCount: 3, queryLength: 9 } }),
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(EVENTS_PATH.startsWith("/")).toBe(true);
  });

  it("falls back to fetch with keepalive when the beacon is refused or missing", () => {
    const fetch = vi.fn(() => Promise.resolve());
    trackClient("page_view", {}, "shop", { navigator: { sendBeacon: () => false }, fetch });
    expect(fetch).toHaveBeenCalledWith(
      EVENTS_PATH,
      expect.objectContaining({ method: "POST", keepalive: true, credentials: "same-origin" }),
    );
  });

  it("sends nothing under Global Privacy Control or Do Not Track, or outside a browser", () => {
    const sendBeacon = vi.fn(() => true);
    const fetch = vi.fn();
    trackClient("page_view", {}, "shop", { navigator: { sendBeacon, globalPrivacyControl: true }, fetch });
    trackClient("page_view", {}, "shop", { navigator: { sendBeacon, doNotTrack: "1" }, fetch });
    trackClient("page_view", {}, "shop", null);
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never throws, even when both transports do", () => {
    expect(() =>
      trackClient("page_view", {}, "shop", {
        navigator: {
          sendBeacon: () => {
            throw new Error("blocked");
          },
        },
        fetch: () => {
          throw new Error("offline");
        },
      }),
    ).not.toThrow();
  });
});
