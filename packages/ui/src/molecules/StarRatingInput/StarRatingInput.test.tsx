import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { StarRatingInput } from "./StarRatingInput";

function Controlled({ initial = null }: { initial?: number | null }) {
  const [value, setValue] = useState<number | null>(initial);
  return <StarRatingInput legend="Your rating" value={value} onChange={setValue} />;
}

describe("StarRatingInput", () => {
  it("REV-2: is a named group of five radios, one per star", () => {
    render(<Controlled />);
    const group = screen.getByRole("group", { name: "Your rating" });
    expect(group.tagName).toBe("FIELDSET");
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual([
      "1 star",
      "2 stars",
      "3 stars",
      "4 stars",
      "5 stars",
    ]);
    for (const r of radios) expect(r).not.toBeChecked();
  });

  it("REV-2: choosing a star checks it and reports the number", () => {
    const onChange = vi.fn();
    render(<StarRatingInput legend="Your rating" value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "4 stars" }));
    expect(onChange).toHaveBeenCalledWith(4);
  });

  it("REV-2: the checked star follows the value, and the stars up to it are filled", () => {
    const { container } = render(<Controlled initial={3} />);
    expect(screen.getByRole("radio", { name: "3 stars" })).toBeChecked();
    expect(container.querySelectorAll("[data-filled='true']")).toHaveLength(3);
    fireEvent.click(screen.getByRole("radio", { name: "5 stars" }));
    expect(screen.getByRole("radio", { name: "5 stars" })).toBeChecked();
    expect(container.querySelectorAll("[data-filled='true']")).toHaveLength(5);
  });

  it("REV-2: the radios share one name, so arrow keys move between them natively", () => {
    render(<Controlled />);
    const names = new Set(screen.getAllByRole("radio").map((r) => r.getAttribute("name")));
    expect(names.size).toBe(1);
    expect([...names][0]).toBeTruthy();
  });

  it("REV-2: an error is shown, tied to the group, and marks it invalid", () => {
    render(
      <StarRatingInput legend="Your rating" value={null} onChange={() => {}} error="Choose a rating." />,
    );
    const group = screen.getByRole("group", { name: "Your rating" });
    const error = screen.getByText("Choose a rating.");
    expect(group).toHaveAttribute("aria-describedby", error.id);
    for (const r of screen.getAllByRole("radio")) expect(r).toHaveAttribute("aria-invalid", "true");
  });

  it("REV-2: a disabled input cannot be changed", () => {
    const onChange = vi.fn();
    render(<StarRatingInput legend="Your rating" value={2} onChange={onChange} disabled />);
    for (const r of screen.getAllByRole("radio")) expect(r).toBeDisabled();
  });

  it("each star has a visible focus style on its control", () => {
    const { container } = render(<Controlled />);
    const star = container.querySelector("input[type='radio'] + svg");
    expect(star?.getAttribute("class")).toMatch(/peer-focus-visible:/);
  });
});
