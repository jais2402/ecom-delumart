import { describe, expect, it } from "vitest";
import { actionWords } from "./action-words";
import { ApiError } from "./api";
import {
  type AdminMethod,
  buildChange,
  changedSettings,
  formFromCurrent,
  isoToIstInput,
  istInputToIso,
  limitText,
  type MethodFormInput,
  type MethodSettings,
  maintenanceText,
  methodChangeSentence,
  methodErrorText,
  proposedSettings,
  settingRows,
} from "./payment-methods-admin";

const settings: MethodSettings = {
  enabled: true,
  displayOrder: 2,
  perAttemptLimitPaise: "1000000000",
  perDayLimitPaise: "5000000000",
  maintenanceFrom: null,
  maintenanceUntil: null,
};

const current: AdminMethod = {
  ...settings,
  method: "NET_BANKING",
  version: 3,
  switchOn: true,
  inMaintenance: false,
  available: true,
  pendingActionId: null,
};

const input = (over: Partial<MethodFormInput> = {}): MethodFormInput => ({
  ...formFromCurrent(current),
  reason: "Planned bank work",
  ...over,
});

describe("R7 Payments row: the console's payment methods screen", () => {
  it("shows limits and the maintenance window in words, exact in paise", () => {
    expect(limitText(null)).toBe("No limit");
    expect(limitText("1000000000")).toBe("₹1,00,00,000");
    expect(maintenanceText(null, null)).toBe("None");
    expect(maintenanceText("2026-11-30T04:30:00Z", "2026-11-30T06:30:00Z")).toBe(
      "30 Nov 2026, 10:00 am IST to 30 Nov 2026, 12:00 pm IST",
    );
    expect(settingRows(settings).map((r) => r.value)).toEqual([
      "Yes",
      "2",
      "₹1,00,00,000",
      "₹5,00,00,000",
      "None",
    ]);
  });

  it("marks only what a proposal changes", () => {
    const next: MethodSettings = { ...settings, enabled: false, perDayLimitPaise: null };
    expect([...changedSettings(settings, next)].sort()).toEqual(["enabled", "perDayLimitPaise"]);
    expect(changedSettings(settings, { ...settings }).size).toBe(0);
    const window = { maintenanceFrom: "2026-11-30T04:30:00Z", maintenanceUntil: "2026-11-30T06:30:00Z" };
    expect(
      changedSettings(
        { ...settings, ...window },
        {
          ...settings,
          maintenanceFrom: "2026-11-30T10:00:00+05:30",
          maintenanceUntil: "2026-11-30T12:00:00+05:30",
        },
      ).size,
    ).toBe(0);
  });

  it("reads a waiting action's settings and refuses details it cannot trust", () => {
    expect(
      proposedSettings({ ...settings, key: "payment_method.NET_BANKING", method: "NET_BANKING" }),
    ).toEqual(settings);
    expect(proposedSettings(undefined)).toBeNull();
    expect(proposedSettings({ ...settings, enabled: "yes" })).toBeNull();
    expect(proposedSettings({ ...settings, perDayLimitPaise: "12.5" })).toBeNull();
  });

  it("describes a waiting action so Pending actions never says 'Unknown action'", () => {
    const details = { ...settings, enabled: false };
    expect(methodChangeSentence("NET_BANKING", details)).toBe(
      "Change Net banking (Delulu Bank): switched off, position 2, per payment ₹1,00,00,000, per day ₹5,00,00,000, no maintenance window",
    );
    expect(
      actionWords({ kind: "payment_method.set", key: "payment_method.CARD", value: null, details }),
    ).toContain("Change Delulu Card");
    expect(actionWords({ kind: "payment_method.set", key: "payment_method.CARD", value: null })).toBe(
      "Change settings of Delulu Card",
    );
    expect(actionWords({ kind: "payment_method.set", key: "bad", value: null })).toBe("Unknown action");
    expect(actionWords({ kind: "config.set", key: "fee_percent", value: "7" })).toBe(
      "Set Marketplace fee to 7%",
    );
  });

  it("converts India time exactly in both directions", () => {
    expect(istInputToIso("2026-11-30T10:00")).toBe("2026-11-30T10:00:00+05:30");
    expect(isoToIstInput("2026-11-30T04:30:00Z")).toBe("2026-11-30T10:00");
    expect(isoToIstInput(null)).toBe("");
    expect(istInputToIso("tomorrow")).toBeNull();
  });

  it("starts the form from the current settings, in whole rupees", () => {
    expect(formFromCurrent(current)).toMatchObject({
      enabled: true,
      displayOrder: "2",
      perAttempt: "10000000",
      perDay: "50000000",
      from: "",
      until: "",
    });
  });

  it("builds the request with money as integer paise strings and no window when none is set", () => {
    const built = buildChange("NET_BANKING", input({ enabled: false, perAttempt: "", perDay: "250000" }));
    expect(built).toEqual({
      ok: true,
      body: {
        method: "NET_BANKING",
        enabled: false,
        displayOrder: 2,
        perAttemptLimitPaise: null,
        perDayLimitPaise: "25000000",
        maintenanceFrom: null,
        maintenanceUntil: null,
        reason: "Planned bank work",
      },
    });
  });

  it("sends a maintenance window with its India offset", () => {
    const built = buildChange("CARD", input({ from: "2026-11-30T10:00", until: "2026-11-30T12:00" }));
    expect(built.ok && built.body.maintenanceFrom).toBe("2026-11-30T10:00:00+05:30");
    expect(built.ok && built.body.maintenanceUntil).toBe("2026-11-30T12:00:00+05:30");
  });

  it("says what is wrong in plain words and sends nothing", () => {
    const bad = buildChange(
      "CARD",
      input({
        displayOrder: "0",
        perAttempt: "1.5",
        perDay: "abc",
        from: "2026-11-30T10:00",
        until: "",
        reason: "no",
      }),
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(Object.keys(bad.problems).sort()).toEqual([
      "displayOrder",
      "perAttempt",
      "perDay",
      "reason",
      "until",
    ]);
    expect(bad.problems.until).toMatch(/needs an end/);
  });

  it("refuses a daily limit below the per-payment limit and a window that ends before it starts", () => {
    const low = buildChange("CARD", input({ perAttempt: "500", perDay: "100" }));
    expect(!low.ok && low.problems.perDay).toMatch(/cannot be lower/);
    const backwards = buildChange("CARD", input({ from: "2026-11-30T12:00", until: "2026-11-30T10:00" }));
    expect(!backwards.ok && backwards.problems.until).toMatch(/end after it starts/);
  });

  it("keeps a huge amount of rupees out of floating point", () => {
    const built = buildChange("CARD", input({ perAttempt: "99999999999", perDay: "99999999999" }));
    expect(built.ok && built.body.perDayLimitPaise).toBe("9999999999900");
    expect(buildChange("CARD", input({ perAttempt: "100000000000" })).ok).toBe(false);
  });

  it("shows the server's refusal of a change that would leave no usable method in plain words", () => {
    const refusal = new ApiError(
      "CONFIG_VALUE_INVALID",
      "after this change at least one payment method must stay usable: enabled, switched on, outside a maintenance window and above the minimum limits",
      false,
      422,
    );
    const text = methodErrorText(refusal);
    expect(text).toMatch(/no payment method they can use/);
    expect(text).not.toMatch(/CONFIG_VALUE_INVALID/);
  });

  it("passes other refusals through in words, and falls back to the shared wording", () => {
    expect(
      methodErrorText(
        new ApiError(
          "CONFIG_VALUE_INVALID",
          "the daily limit cannot be below the per-payment limit",
          false,
          422,
        ),
      ),
    ).toBe("This change was refused: the daily limit cannot be below the per-payment limit.");
    expect(methodErrorText(new ApiError("REAUTH_REQUIRED", "x", false, 401))).toMatch(/recent sign-in/);
    expect(methodErrorText(new ApiError("CONFLICT", "x", false, 409))).toMatch(
      /same as the current settings/,
    );
    expect(methodErrorText(new Error("boom"))).toBe("Something went wrong. Try again.");
  });
});
