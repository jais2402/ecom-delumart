import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PriceBlock } from "./PriceBlock";

describe("PriceBlock", () => {
  it("renders the current price with an accessible label", () => {
    render(<PriceBlock amountPaise={50_000_00n} />);
    expect(screen.getByText(/fictional rupees/)).toBeInTheDocument();
  });
  it("renders a struck-through reference price with 'Was' text and a sale badge", () => {
    const { container } = render(
      <PriceBlock amountPaise={50_000_00n} referenceAmountPaise={80_000_00n} saleLabel="Sale" />,
    );
    expect(screen.getByText("Was")).toBeInTheDocument();
    expect(container.querySelector(".line-through")).toBeInTheDocument();
    expect(screen.getByText("Sale")).toBeVisible();
  });
  it("omits reference and badge by default", () => {
    render(<PriceBlock amountPaise={100n} saleLabel="Sale" />);
    expect(screen.queryByText("Was")).toBeNull();
    expect(screen.queryByText("Sale")).toBeNull();
  });
  it("lets a page enlarge the main price without changing its spoken label", () => {
    const { container } = render(
      <PriceBlock amountPaise={199_900n} display="exact" priceClassName="text-4xl" />,
    );
    expect(container.querySelector(".text-4xl")).not.toBeNull();
    expect(screen.getByText(/fictional rupees/)).toBeInTheDocument();
  });
});
