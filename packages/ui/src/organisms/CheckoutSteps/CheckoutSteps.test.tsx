import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CheckoutSteps } from "./CheckoutSteps";

describe("CheckoutSteps", () => {
  it("lists the four steps in order", () => {
    render(<CheckoutSteps current={0} />);
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items.join("|")).toMatch(/Delivery.*Speed.*Payment.*Review/);
  });
  it("marks the current step and completed steps", () => {
    render(<CheckoutSteps current={2} />);
    expect(screen.getByText("Payment").closest("li")).toHaveAttribute("aria-current", "step");
    expect(screen.getByText(/Delivery/)).toHaveTextContent("(completed)");
  });
  it("is a labelled navigation", () => {
    render(<CheckoutSteps current={1} />);
    expect(screen.getByRole("navigation", { name: "Checkout progress" })).toBeInTheDocument();
  });
});
