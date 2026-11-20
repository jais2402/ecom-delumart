import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VisuallyHidden } from "./VisuallyHidden";

describe("VisuallyHidden", () => {
  it("renders its text in the accessibility tree", () => {
    render(<VisuallyHidden>Hidden hint</VisuallyHidden>);
    expect(screen.getByText("Hidden hint")).toBeInTheDocument();
  });
  it("uses the sr-only class and merges className", () => {
    render(<VisuallyHidden className="extra">x</VisuallyHidden>);
    expect(screen.getByText("x")).toHaveClass("sr-only", "extra");
  });
  it("is not marked aria-hidden", () => {
    render(<VisuallyHidden>y</VisuallyHidden>);
    expect(screen.getByText("y")).not.toHaveAttribute("aria-hidden");
  });
});
