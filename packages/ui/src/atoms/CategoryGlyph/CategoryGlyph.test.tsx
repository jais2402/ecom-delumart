import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ART_MOTIFS } from "../ProductArt";
import { CategoryGlyph } from "./CategoryGlyph";

describe("CategoryGlyph", () => {
  it("renders an icon for every motif, hidden from assistive technology", () => {
    for (const motif of ART_MOTIFS) {
      const { container, unmount } = render(<CategoryGlyph motif={motif} />);
      expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      unmount();
    }
  });
  it("gets an accessible name only when labelled", () => {
    render(<CategoryGlyph motif="cosmic" label="Cosmic" />);
    expect(screen.getByRole("img", { name: "Cosmic" })).toBeInTheDocument();
  });
  it("accepts a class name", () => {
    const { container } = render(<CategoryGlyph motif="tech" className="x-test" />);
    expect(container.querySelector("svg")).toHaveClass("x-test");
  });
});
