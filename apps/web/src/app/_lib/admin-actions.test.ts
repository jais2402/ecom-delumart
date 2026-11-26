import { CONFIG_KEYS } from "@delulu/core";
import { describe, expect, it } from "vitest";
import {
  actionErrorText,
  actionSentence,
  inputToStoredValue,
  stateBadge,
  storedValueToInput,
  valueText,
} from "./admin-actions";
import { ApiError } from "./api";

const spec = (key: string) => {
  const s = CONFIG_KEYS.find((k) => k.key === key);
  if (!s) throw new Error(key);
  return s;
};

describe("R16.6, R7: the Super Admin's pending actions and configuration screens", () => {
  it("US-60: an action reads as a sentence a person can check before it runs", () => {
    expect(actionSentence({ kind: "config.set", key: "fee_percent", value: "7" })).toBe(
      "Set Marketplace fee to 7%",
    );
    expect(actionSentence({ kind: "config.set", key: "delivery_fee_paise.ZAP", value: "6000000" })).toBe(
      "Set Zap delivery fee to ₹60,000",
    );
    expect(actionSentence({ kind: "mint.currency", key: null, value: null })).toBe("Unknown action");
    expect(actionSentence({ kind: "config.set", key: "nonsense", value: "1" })).toBe("Unknown action");
  });

  it("invariant 1: a rupee amount typed by the person becomes whole paise without any floating point", () => {
    const zap = spec("delivery_fee_paise.ZAP");
    expect(inputToStoredValue(zap, "1200")).toBe("120000");
    expect(inputToStoredValue(zap, "0")).toBe("0");
    expect(inputToStoredValue(zap, "100000")).toBe("10000000"); // the ceiling, ₹1,00,000
    expect(inputToStoredValue(zap, "100001")).toBeNull(); // above the ceiling
    for (const bad of ["", "1.5", "-1", "1e3", " 5", "५", "abc", "0x10", "99999999999999999999"])
      expect(inputToStoredValue(zap, bad), bad).toBeNull();
    const fee = spec("fee_percent");
    expect(inputToStoredValue(fee, "20")).toBe("20");
    expect(inputToStoredValue(fee, "21")).toBeNull();
    expect(inputToStoredValue(fee, "07")).toBeNull();
    expect(inputToStoredValue(fee, "5.5")).toBeNull();
  });

  it("a stored value shows in the unit the person types", () => {
    expect(storedValueToInput(spec("delivery_fee_paise.STANDARD"), "100000")).toBe("1000");
    expect(storedValueToInput(spec("fee_percent"), "5")).toBe("5");
    expect(valueText(spec("delivery_fee_paise.STANDARD"), "100000")).toBe("₹1,000");
    expect(valueText(spec("fee_percent"), "5")).toBe("5%");
  });

  it("each state has one badge tone and a label that is not colour alone", () => {
    expect(stateBadge("QUEUED")).toEqual({ tone: "info", label: "Waiting" });
    expect(stateBadge("EXECUTED")).toEqual({ tone: "success", label: "Applied" });
    expect(stateBadge("CANCELLED")).toEqual({ tone: "neutral", label: "Cancelled" });
    expect(stateBadge("FAILED")).toEqual({ tone: "danger", label: "Failed" });
  });

  it("US-60: errors read in plain language; a stale sign-in says to sign in again", () => {
    const e = (code: string, status = 422) => new ApiError(code, "server words", false, status);
    expect(actionErrorText(e("REAUTH_REQUIRED", 401))).toMatch(/sign in again/i);
    expect(actionErrorText(e("CONFLICT", 409))).toMatch(/already/i);
    expect(actionErrorText(e("ADMIN_ACTION_LIMIT", 409))).toMatch(/waiting/i);
    expect(actionErrorText(e("CONFIG_VALUE_INVALID"))).toMatch(/allowed range/i);
    expect(actionErrorText(e("CONFIG_KEY_UNKNOWN"))).toMatch(/cannot be changed/i);
    expect(actionErrorText(new Error("boom"))).toBe("Something went wrong. Try again.");
  });
});
