import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FictionLabel } from "./FictionLabel";

describe("FictionLabel", () => {
  it("says Fictional money by default", () => {
    render(<FictionLabel />);
    expect(screen.getByText("Fictional money")).toBeVisible();
  });
  it("accepts custom text", () => {
    render(<FictionLabel>Pretend rupees</FictionLabel>);
    expect(screen.getByText("Pretend rupees")).toBeInTheDocument();
  });
  it("is plain text, not hidden from assistive tech", () => {
    render(<FictionLabel />);
    expect(screen.getByText("Fictional money")).not.toHaveAttribute("aria-hidden");
  });
});
