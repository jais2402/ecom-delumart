import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Spinner } from "./Spinner";

describe("Spinner", () => {
  it("is a status with a default label", () => {
    render(<Spinner />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
  });
  it("accepts a custom label", () => {
    render(<Spinner label="Paying" />);
    expect(screen.getByRole("status", { name: /Paying/ })).toBeInTheDocument();
  });
  it("hides the animated glyph from assistive tech", () => {
    const { container } = render(<Spinner />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});
