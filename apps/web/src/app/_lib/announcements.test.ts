import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAnnouncements, resetAnnouncementsForTests } from "./announcements";

const item = {
  id: "0192f6a0-0000-7000-8000-000000000001",
  key: "fee_percent",
  value: "6",
  effectiveFrom: "2026-11-27T04:00:00.000Z",
  announcedAt: "2026-11-27T04:00:00.000Z",
};

describe("R7: the storefront announcement data", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    resetAnnouncementsForTests();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const ok = (items: unknown[]) =>
    new Response(JSON.stringify({ items }), { status: 200, headers: { "content-type": "application/json" } });

  it("reads the public route once and keeps the answer for a minute", async () => {
    fetchMock.mockImplementation(async () => ok([item]));
    let clock = 1_000;
    expect(await loadAnnouncements(() => clock)).toEqual([item]);
    clock += 30_000;
    expect(await loadAnnouncements(() => clock)).toEqual([item]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/v1/announcements");
    clock += 31_000;
    await loadAnnouncements(() => clock);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shows nothing, and never throws, when the request fails", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 500 }));
    expect(await loadAnnouncements()).toEqual([]);
    fetchMock.mockRejectedValue(new TypeError("offline"));
    expect(await loadAnnouncements(() => Date.now() + 120_000)).toEqual([]);
  });
});
