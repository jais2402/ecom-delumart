import { describe, expect, it } from "vitest";
import { DEFAULT_RETURN_PATH, getReturnTo, safeReturnPath, setReturnTo } from "./onboarding-flow";

const ORIGIN = "https://app.delulu.test";

/** Each of these must never leave the site: the helper answers the default instead. */
const HOSTILE: [string, string | null | undefined][] = [
  ["protocol-relative", "//evil.example/x"],
  ["backslash host", "/\\evil.example/x"],
  ["backslash first", "\\\\evil.example"],
  ["tab after slash (the reported attack, decoded)", "/\t/evil.example/x"],
  ["newline after slash", "/\n/evil.example/x"],
  ["carriage return after slash", "/\r/evil.example/x"],
  ["NUL", "/\u0000/evil.example"],
  ["DEL", "/\u007f/evil.example"],
  ["encoded tab", "/%09/evil.example/x"],
  ["encoded newline", "/%0a/evil.example/x"],
  ["encoded slash prefix", "/%2F/evil.example"],
  ["encoded backslash", "/%5Cevil.example"],
  ["double-encoded slash", "%2F%2Fevil.example"],
  ["absolute https", "https://evil.example/x"],
  ["absolute http", "http://evil.example"],
  ["scheme-relative with spaces", " //evil.example"],
  ["javascript url", "javascript:alert(1)"],
  ["javascript url with comment", "javascript:alert(1)//x"],
  ["data url", "data:text/html,<script>alert(1)</script>"],
  ["same scheme other host", `${ORIGIN}.evil.example/x`],
  ["userinfo trick", "//app.delulu.test@evil.example"],
  ["dot segments to protocol-relative", "/.//evil.example"],
  ["relative path", "account"],
  ["empty", ""],
  ["null", null],
  ["undefined", undefined],
  ["very long", `/${"a".repeat(5000)}`],
  ["malformed escape", "/%E0%A4%A"],
];

const BENIGN: [string, string][] = [
  ["/p/abc", "/p/abc"],
  ["/cart", "/cart"],
  ["/checkout/0192f6a0-0000-7000-8000-0000000000ff", "/checkout/0192f6a0-0000-7000-8000-0000000000ff"],
  ["/ok?next=//evil", "/ok?next=//evil"],
  ["/search?q=a%20b#top", "/search?q=a%20b#top"],
  ["/", "/"],
];

describe("safeReturnPath (fifth security review, open redirect after sign-in)", () => {
  it.each(HOSTILE)("US-01: refuses %s", (_name, value) => {
    expect(safeReturnPath(value, ORIGIN)).toBe(DEFAULT_RETURN_PATH);
  });

  it.each(BENIGN)("US-01: keeps the same-site path %s", (value, expected) => {
    expect(safeReturnPath(value, ORIGIN)).toBe(expected);
  });

  it("US-01: whatever it returns resolves to the app's own origin", () => {
    for (const [, value] of [...HOSTILE, ...BENIGN]) {
      const out = safeReturnPath(value, ORIGIN);
      expect(out.startsWith("/")).toBe(true);
      expect(out.startsWith("//")).toBe(false);
      expect(new URL(out, ORIGIN).origin).toBe(ORIGIN);
    }
  });

  it("US-01: the stored return path is validated the same way", () => {
    setReturnTo("/\t/evil.example/x", ORIGIN);
    expect(getReturnTo()).toBe(DEFAULT_RETURN_PATH);
    setReturnTo("/p/abc", ORIGIN);
    expect(getReturnTo()).toBe("/p/abc");
  });
});
