import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ReliefPanel } from "./ReliefPanel";

const LAKH = 100_000n * 100n;
const candidates = [
  { id: "p1", name: "Cloud Kettle" },
  { id: "p2", name: "Pocket Moon" },
];

describe("ReliefPanel", () => {
  it("offers the grant, the remaining claims and the UTC reset note, without pressure", () => {
    render(
      <ReliefPanel
        grantPaise={10n * LAKH}
        claimsRemaining={6}
        claimsMax={7}
        candidates={candidates}
        onClaim={() => {}}
      />,
    );
    expect(screen.getByRole("region", { name: "Low balance" })).toBeInTheDocument();
    expect(
      screen.getByText(/of fictional money once a day by saving a product you have not saved before/),
    ).toBeInTheDocument();
    expect(screen.getByText(/6 of 7 claims left/)).toBeInTheDocument();
    expect(screen.getByText(/midnight UTC/)).toBeInTheDocument();
  });
  it("claims the chosen product, first one by default", async () => {
    const onClaim = vi.fn();
    render(
      <ReliefPanel
        grantPaise={10n * LAKH}
        claimsRemaining={6}
        claimsMax={7}
        candidates={candidates}
        onClaim={onClaim}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Save and claim" }));
    expect(onClaim).toHaveBeenLastCalledWith("p1");
    await userEvent.click(screen.getByRole("radio", { name: "Pocket Moon" }));
    await userEvent.click(screen.getByRole("button", { name: "Save and claim" }));
    expect(onClaim).toHaveBeenLastCalledWith("p2");
  });
  it("after a claim shows the new balance and the reset note instead of the picker", () => {
    render(
      <ReliefPanel
        grantPaise={10n * LAKH}
        claimsRemaining={5}
        claimsMax={7}
        candidates={candidates}
        onClaim={() => {}}
        result={{ balancePaise: 12n * LAKH, nextResetAt: "2026-11-22T00:00:00.000Z" }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/Claimed\. Your balance is now/);
    expect(screen.getByRole("status")).toHaveTextContent(/resets at midnight UTC/);
    expect(screen.queryByRole("button", { name: "Save and claim" })).not.toBeInTheDocument();
  });
});
