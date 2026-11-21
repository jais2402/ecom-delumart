import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PassportStepCard } from "./PassportStepCard";

describe("PassportStepCard", () => {
  it("is a region named after the step and says To do in words", () => {
    render(
      <PassportStepCard title="Save three products" done={false} summary="1 of 3 saved">
        <a href="/">Browse</a>
      </PassportStepCard>,
    );
    const region = screen.getByRole("region", { name: "Save three products" });
    expect(region).toHaveAttribute("data-done", "false");
    expect(screen.getByText("To do")).toBeInTheDocument();
    expect(screen.getByText("1 of 3 saved")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Browse" })).toBeInTheDocument();
  });
  it("says Done when complete", () => {
    render(<PassportStepCard title="Quiz" done />);
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.queryByText("To do")).not.toBeInTheDocument();
  });
});
