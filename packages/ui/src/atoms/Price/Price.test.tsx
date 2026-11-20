import { formatInrCompact, formatInrExact, inrAccessibleLabel } from "@delulu/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Price } from "./Price";

const amount = 20_000_000_00n;

describe("Price", () => {
  it("shows compact text by default and an accessible label", () => {
    render(<Price amountPaise={amount} />);
    expect(screen.getByText(formatInrCompact(amount))).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText(inrAccessibleLabel(amount))).toBeInTheDocument();
  });
  it("shows exact text when asked", () => {
    render(<Price amountPaise={123_456n} display="exact" />);
    expect(screen.getByText(formatInrExact(123_456n))).toBeInTheDocument();
  });
  it("hides visible text from the accessible name, exposing only the label", () => {
    const { container } = render(<Price amountPaise={amount} />);
    expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent(formatInrCompact(amount));
    expect(screen.getByText(inrAccessibleLabel(amount))).toHaveClass("sr-only");
  });
});
