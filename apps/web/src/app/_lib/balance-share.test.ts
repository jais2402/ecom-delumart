import { describe, expect, it } from "vitest";
import { shareOfStartingBalance } from "./balance-share";

const GRANT = 100_000_000_000n; // a test grant of 1000 crore paise-units, independent of the real one

describe("shareOfStartingBalance", () => {
  it("is exact for round shares", () => {
    expect(shareOfStartingBalance(GRANT, GRANT)).toBe("100%");
    expect(shareOfStartingBalance(GRANT / 2n, GRANT)).toBe("50%");
    expect(shareOfStartingBalance(GRANT / 1000n, GRANT)).toBe("0.1%");
  });
  it("floors to five decimals (0.000088% shows as 0.00008%) and trims trailing zeros", () => {
    expect(shareOfStartingBalance(88_000n, GRANT)).toBe("0.00008%");
    expect(shareOfStartingBalance(1n, GRANT)).toBe("0%");
  });
  it("keeps a smallest price visible and refuses nonsense", () => {
    expect(shareOfStartingBalance(10_000n, GRANT)).toBe("0.00001%");
    expect(shareOfStartingBalance(5n, 0n)).toBe("");
    expect(shareOfStartingBalance(-1n, GRANT)).toBe("");
  });
  it("uses bigint only, so huge amounts stay exact", () => {
    expect(shareOfStartingBalance(10n ** 20n, 10n ** 20n)).toBe("100%");
  });
});
