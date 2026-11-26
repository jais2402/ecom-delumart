import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CarouselControls } from "./CarouselControls";

describe("CarouselControls", () => {
  it("names every button and marks the dot in view", () => {
    render(<CarouselControls count={3} index={1} onSelect={() => {}} noun="featured product" />);
    expect(screen.getByRole("button", { name: "Previous featured product" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next featured product" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show featured product 2 of 3" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.getByRole("button", { name: "Show featured product 1 of 3" })).not.toHaveAttribute(
      "aria-current",
    );
  });
  it("asks for the next, previous and chosen slide, wrapping at the ends", async () => {
    const onSelect = vi.fn();
    render(<CarouselControls count={3} index={0} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("button", { name: "Previous slide" }));
    expect(onSelect).toHaveBeenLastCalledWith(2);
    await userEvent.click(screen.getByRole("button", { name: "Next slide" }));
    expect(onSelect).toHaveBeenLastCalledWith(1);
    await userEvent.click(screen.getByRole("button", { name: "Show slide 3 of 3" }));
    expect(onSelect).toHaveBeenLastCalledWith(2);
  });
  it("can be reached and pressed with the keyboard, with 44px targets", async () => {
    const onSelect = vi.fn();
    render(<CarouselControls count={2} index={0} onSelect={onSelect} />);
    await userEvent.tab();
    const previous = screen.getByRole("button", { name: "Previous slide" });
    expect(previous).toHaveFocus();
    expect(previous).toHaveClass("min-h-touch", "min-w-touch");
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith(1);
  });
  it("draws nothing for a single slide, and merges the class name", () => {
    const { container, rerender } = render(<CarouselControls count={1} index={0} onSelect={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<CarouselControls count={2} index={0} onSelect={() => {}} className="x-test" />);
    expect(container.firstElementChild).toHaveClass("x-test");
  });
});
