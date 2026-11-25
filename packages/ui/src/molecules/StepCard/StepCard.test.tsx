import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StepCard } from "./StepCard";

describe("StepCard", () => {
  it("names the step in its heading for screen readers", () => {
    render(<StepCard step={2} title="Spend it" text="Pick something impossible." />);
    expect(screen.getByRole("heading", { level: 3, name: "Step 2: Spend it" })).toBeInTheDocument();
    expect(screen.getByText("Pick something impossible.")).toBeInTheDocument();
  });
  it("uses the requested heading level and merges the class name", () => {
    const { container } = render(
      <StepCard step={1} title="Start" text="x" headingLevel={2} className="x-test" />,
    );
    expect(screen.getByRole("heading", { level: 2 })).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass("x-test");
  });
});
