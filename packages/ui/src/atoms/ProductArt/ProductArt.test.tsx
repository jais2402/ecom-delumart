import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ART_MOTIFS, motifFromSeed, ProductArt } from "./ProductArt";

describe("ProductArt", () => {
  it("is an image with the given accessible name", () => {
    render(<ProductArt hue={200} seed="jar" alt="A jar of monsoon" />);
    expect(screen.getByRole("img", { name: "A jar of monsoon" })).toBeInTheDocument();
  });
  it("draws the same picture for the same inputs and a different one for another seed", () => {
    const a = render(<ProductArt hue={10} seed="x" alt="a" />).container.innerHTML;
    const b = render(<ProductArt hue={10} seed="x" alt="a" />).container.innerHTML;
    const c = render(<ProductArt hue={10} seed="y" alt="a" />).container.innerHTML;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
  it("is hidden from assistive technology when decorative", () => {
    const { container } = render(<ProductArt hue={90} seed="s" alt="" />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
  it("keeps a square aspect ratio", () => {
    const { container } = render(<ProductArt hue={90} seed="s" alt="x" />);
    expect(container.querySelector("svg")).toHaveClass("aspect-square");
  });
  it("draws a different object for each motif and picks one from the seed when none is given", () => {
    const html = ART_MOTIFS.map(
      (motif) => render(<ProductArt hue={40} seed="s" alt="x" motif={motif} />).container.innerHTML,
    );
    expect(new Set(html).size).toBe(ART_MOTIFS.length);
    expect(ART_MOTIFS).toContain(motifFromSeed("anything"));
    expect(motifFromSeed("anything")).toBe(motifFromSeed("anything"));
  });
  it("is a plain backdrop with one object: no external image, gradient or sparkle", () => {
    const { container } = render(<ProductArt hue={300} seed="s" alt="x" motif="cosmic" />);
    expect(container.querySelector("image, img, linearGradient, radialGradient")).toBeNull();
    expect(container.querySelector("svg")).toHaveClass("bg-surface-raised");
    expect(container.querySelector("svg")?.getAttribute("style")).toBeNull();
  });
});
