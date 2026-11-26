import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StarRating } from "./StarRating";

describe("StarRating", () => {
  it("REV-3: is one image named with the average and the count", () => {
    render(<StarRating averageTenths={43} count={12} />);
    const img = screen.getByRole("img", { name: "4.3 out of 5 stars, 12 reviews" });
    // the five stars inside are decorative
    expect(img.querySelectorAll("svg")).toHaveLength(5);
    for (const star of img.querySelectorAll("svg")) expect(star).toHaveAttribute("aria-hidden", "true");
  });

  it("REV-3: one review is singular; none says so", () => {
    render(<StarRating averageTenths={50} count={1} />);
    expect(screen.getByRole("img", { name: "5.0 out of 5 stars, 1 review" })).toBeInTheDocument();
  });

  it("REV-3: with no reviews it reads 'No reviews yet' and fills no star", () => {
    const { container } = render(<StarRating averageTenths={0} count={0} />);
    expect(screen.getByRole("img", { name: "No reviews yet" })).toBeInTheDocument();
    expect(container.querySelectorAll("[data-filled='true']")).toHaveLength(0);
  });

  it("REV-3: fills stars to the nearest whole star", () => {
    const { container, rerender } = render(<StarRating averageTenths={43} count={3} />);
    expect(container.querySelectorAll("[data-filled='true']")).toHaveLength(4);
    rerender(<StarRating averageTenths={45} count={3} />);
    expect(container.querySelectorAll("[data-filled='true']")).toHaveLength(5);
    rerender(<StarRating averageTenths={14} count={3} />);
    expect(container.querySelectorAll("[data-filled='true']")).toHaveLength(1);
  });

  it("REV-3: a single review's rating can be named on its own", () => {
    render(<StarRating averageTenths={40} label="Rated 4 out of 5" />);
    expect(screen.getByRole("img", { name: "Rated 4 out of 5" })).toBeInTheDocument();
  });

  it("uses design tokens, never raw colours", () => {
    const { container } = render(<StarRating averageTenths={30} count={2} />);
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    expect(container.querySelector("[data-filled='true']")).toHaveClass("fill-sun");
  });
});
