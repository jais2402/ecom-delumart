import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StepIndicator } from "./StepIndicator";

describe("StepIndicator", () => {
  it("renders an ordered list of steps", () => {
    render(<StepIndicator steps={["Cart", "Delivery", "Pay"]} current={1} />);
    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });
  it("marks only the current step with aria-current=step", () => {
    render(<StepIndicator steps={["Cart", "Delivery", "Pay"]} current={1} />);
    const items = screen.getAllByRole("listitem");
    expect(items[1]).toHaveAttribute("aria-current", "step");
    expect(items[0]).not.toHaveAttribute("aria-current");
    expect(items[2]).not.toHaveAttribute("aria-current");
  });
  it("announces completed steps in text", () => {
    render(<StepIndicator steps={["Cart", "Delivery"]} current={1} />);
    expect(screen.getByText("(completed)")).toBeInTheDocument();
  });
  it("shows numbers for upcoming steps and a ringed current step", () => {
    render(<StepIndicator steps={["Cart", "Delivery", "Pay"]} current={1} />);
    const items = screen.getAllByRole("listitem");
    expect(items[2]).toHaveTextContent("3");
    expect(items[1]?.querySelector("span[aria-hidden]:not(.absolute)")).toHaveClass("ring-4");
  });
});
