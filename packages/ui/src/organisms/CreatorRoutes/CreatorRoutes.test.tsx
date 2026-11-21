import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CreatorRoutes } from "./CreatorRoutes";

const CRORE = 10_000_000n * 100n;
const base = {
  spend: {
    balancePaise: 100n * CRORE,
    thresholdPaise: CRORE,
    startingBalancePaise: 100n * CRORE,
    reached: false,
  },
  passport: {
    href: "/sell/passport",
    steps: [
      { label: "Pass the quiz", done: true },
      { label: "Save three products", done: false },
      { label: "Write your concept", done: false },
    ],
  },
};

describe("CreatorRoutes", () => {
  it("shows both routes as named regions with exact progress", () => {
    render(<CreatorRoutes {...base} />);
    const spend = screen.getByRole("region", { name: /Spend down below/ });
    const passport = screen.getByRole("region", { name: "Inventor Passport — free" });
    expect(within(spend).getByRole("progressbar", { name: /creator threshold/ })).toHaveAttribute(
      "aria-valuenow",
      "0",
    );
    expect(within(spend).getByText(/does not count/)).toBeInTheDocument();
    expect(within(spend).getByText(/Spend more than/)).toBeInTheDocument();
    expect(within(passport).getByText("1 of 3 steps done. Do them in any order.")).toBeInTheDocument();
    expect(within(passport).getAllByRole("listitem")).toHaveLength(3);
    expect(within(passport).getByRole("link", { name: "Open the passport" })).toHaveAttribute(
      "href",
      "/sell/passport",
    );
  });
  it("marks the route that unlocked access", () => {
    render(<CreatorRoutes {...base} unlockedBy="PASSPORT" />);
    expect(
      within(screen.getByRole("region", { name: "Inventor Passport — free" })).getByText("Unlocked this way"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Unlocked this way")).toHaveLength(1);
  });
  it("signed out: no balance, no passport link, and a sign-in action slot", () => {
    render(
      <CreatorRoutes
        {...base}
        spend={{ ...base.spend, balancePaise: null }}
        signedOut
        signInAction={<a href="/sign-in">Sign in to start</a>}
      />,
    );
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /passport/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in to start" })).toBeInTheDocument();
  });
});
