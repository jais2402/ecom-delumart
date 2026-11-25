import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProductPicture } from "./ProductPicture";

const base = { hue: 100, seed: "jar", alt: "A jar of monsoon" };

describe("ProductPicture", () => {
  it("draws generated art, named by the alt text, when there is no photo", () => {
    const { container } = render(<ProductPicture {...base} motif="food" />);
    expect(screen.getByRole("img", { name: "A jar of monsoon" })).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });
  it("shows the photo as a lazy, async, explicitly sized same-origin image", () => {
    render(<ProductPicture {...base} imageSrc="/products/jar.webp" />);
    const img = screen.getByRole("img", { name: "A jar of monsoon" });
    expect(img).toHaveAttribute("src", "/products/jar.webp");
    expect(img).toHaveAttribute("width", "900");
    expect(img).toHaveAttribute("height", "900");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("decoding", "async");
    expect(img).toHaveClass("object-cover", "aspect-square");
  });
  it("loads eagerly above the fold and is hidden from assistive technology when decorative", () => {
    const { container } = render(<ProductPicture {...base} alt="" imageSrc="/products/jar.webp" eager />);
    expect(container.querySelector("img")).toHaveAttribute("loading", "eager");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
