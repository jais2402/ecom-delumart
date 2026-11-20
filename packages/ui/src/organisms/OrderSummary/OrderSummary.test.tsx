import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OrderSummary } from "./OrderSummary";

describe("OrderSummary", () => {
  it("lists items, delivery and total with the fiction label", () => {
    render(<OrderSummary itemsTotalPaise={100_000n} deliveryFeePaise={100_00n} totalPaise={101_000n} />);
    expect(screen.getByRole("region", { name: "Order summary" })).toBeInTheDocument();
    expect(screen.getByText("Items")).toBeInTheDocument();
    expect(screen.getByText("Delivery")).toBeInTheDocument();
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("Fictional money")).toBeInTheDocument();
  });
  it("shows the discount row only when there is a discount", () => {
    const { rerender } = render(
      <OrderSummary itemsTotalPaise={100n} deliveryFeePaise={0n} totalPaise={100n} />,
    );
    expect(screen.queryByText("Discount")).not.toBeInTheDocument();
    rerender(<OrderSummary itemsTotalPaise={100n} discountPaise={10n} deliveryFeePaise={0n} totalPaise={90n} />);
    expect(screen.getByText("Discount")).toBeInTheDocument();
  });
  it("says Free for a zero delivery fee and pairs terms with values", () => {
    const { container } = render(<OrderSummary itemsTotalPaise={100n} deliveryFeePaise={0n} totalPaise={100n} />);
    expect(screen.getByText("Free")).toBeInTheDocument();
    expect(container.querySelectorAll("dt")).toHaveLength(container.querySelectorAll("dd").length);
  });
});
