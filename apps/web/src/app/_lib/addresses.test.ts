import { describe, expect, it } from "vitest";
import { addAddressHref, safeReturnPath } from "./addresses";

describe("safeReturnPath (open-redirect guard)", () => {
  const id = "0192f0a0-1234-7abc-8def-0123456789ab";
  it("returns only to one of our own checkout pages", () => {
    expect(safeReturnPath(`/checkout/${id}`)).toBe(`/checkout/${id}`);
    for (const bad of [
      null,
      undefined,
      "",
      "https://evil.example/checkout/x",
      "//evil.example",
      `/checkout/${id}/../../account`,
      `/checkout/${id}?x=1`,
      "/account",
      "javascript:alert(1)",
      `/checkout/${id}#frag`,
    ]) {
      expect(safeReturnPath(bad), String(bad)).toBeNull();
    }
  });
  it("builds the add-address link back to the checkout", () => {
    expect(addAddressHref(id)).toBe(`/account/addresses?add=1&next=${encodeURIComponent(`/checkout/${id}`)}`);
    const next = new URLSearchParams(addAddressHref(id).split("?")[1]).get("next");
    expect(safeReturnPath(next)).toBe(`/checkout/${id}`);
  });
});
