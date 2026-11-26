import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { clock, failureText, secondsUntil, statusTone, unavailableText, wrongCodeText } from "./payments";

describe("payments helpers", () => {
  it("US-34: every failure text says that no fictional money moved", () => {
    for (const code of [
      "CHALLENGE_LOCKED",
      "CANCELLED",
      "METHOD_LIMIT_EXCEEDED",
      "CHECKOUT_EXPIRED",
      "SOMETHING_NEW",
      null,
    ]) {
      expect(failureText(code).message).toMatch(/No fictional money moved\./);
    }
  });

  it("US-36: a wrong code says how many tries are left, singular and plural, and that nothing moved", () => {
    const two = new ApiError("CHALLENGE_FAILED", "x", false, 422, { remainingTries: 2 });
    const one = new ApiError("CHALLENGE_FAILED", "x", false, 422, { remainingTries: 1 });
    expect(wrongCodeText(two)).toBe("That code is not right. 2 tries left. No fictional money moved.");
    expect(wrongCodeText(one)).toBe("That code is not right. 1 try left. No fictional money moved.");
    expect(wrongCodeText(new Error("x"))).toMatch(/No fictional money moved\./);
  });

  it("R4.6: a method in maintenance names when it ends; a switched-off one says so", () => {
    const base = {
      method: "NET_BANKING" as const,
      displayOrder: 3,
      available: false,
      maintenanceUntil: null,
      perAttemptLimitPaise: null,
      perDayLimitPaise: null,
    };
    expect(unavailableText({ ...base, reason: "OFF" }, () => "")).toMatch(/Switched off/);
    expect(
      unavailableText(
        { ...base, reason: "MAINTENANCE", maintenanceUntil: "2030-01-01T10:00:00Z" },
        () => "10:00",
      ),
    ).toBe("Bank maintenance until 10:00. Try another method.");
  });

  it("formats countdowns and statuses", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(65)).toBe("1:05");
    expect(clock(180)).toBe("3:00");
    expect(clock(-3)).toBe("0:00");
    expect(secondsUntil(10_000, 4_500)).toBe(6);
    expect(secondsUntil(1_000, 4_500)).toBe(0);
    expect(statusTone("CAPTURED")).toBe("success");
    expect(statusTone("FAILED")).toBe("danger");
    expect(statusTone("AUTHENTICATING")).toBe("warning");
  });
});
