import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProductCardSkeleton } from "./ProductCardSkeleton";

describe("ProductCardSkeleton", () => {
  it("is hidden from assistive technology and has no controls", () => {
    const { container } = render(<ProductCardSkeleton />);
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector("a, button")).toBeNull();
  });
  it("merges the class name", () => {
    const { container } = render(<ProductCardSkeleton className="x-test" />);
    expect(container.firstElementChild).toHaveClass("x-test");
  });
});
