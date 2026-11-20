import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Skeleton } from "./Skeleton";

describe("Skeleton", () => {
  it("renders a decorative block", () => {
    const { container } = render(<Skeleton />);
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });
  it("merges className, letting size override defaults", () => {
    const { container } = render(<Skeleton className="h-10 w-full" />);
    expect(container.firstElementChild).toHaveClass("h-10", "w-full");
    expect(container.firstElementChild).not.toHaveClass("h-4");
  });
  it("respects reduced motion", () => {
    const { container } = render(<Skeleton />);
    expect(container.firstElementChild).toHaveClass("motion-reduce:animate-none");
  });
});
