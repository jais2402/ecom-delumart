import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProgressBar } from "./ProgressBar";

describe("ProgressBar", () => {
  it("has role progressbar with a name and aria values", () => {
    render(<ProgressBar value={40} label="Upload" />);
    const bar = screen.getByRole("progressbar", { name: "Upload" });
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(bar).toHaveAttribute("aria-valuenow", "40");
  });
  it("clamps values to the range", () => {
    render(<ProgressBar value={500} max={10} label="Over" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "10");
  });
  it("sets the fill width", () => {
    render(<ProgressBar value={1} max={4} label="Quarter" />);
    expect(screen.getByRole("progressbar").firstElementChild).toHaveStyle({ width: "25%" });
  });
});
