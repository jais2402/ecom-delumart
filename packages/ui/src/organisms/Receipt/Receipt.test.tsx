import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Receipt } from "./Receipt";

const props = {
  reference: "DM-1042",
  lines: [{ id: "a", name: "Pocket Comet", quantity: 2, totalPaise: 2_000_00n }],
  itemsTotalPaise: 2_000_00n,
  deliveryFeePaise: 100_00n,
  totalPaise: 2_100_00n,
};

describe("Receipt", () => {
  it("shows the order reference and lines", () => {
    render(<Receipt {...props} />);
    const region = screen.getByRole("region", { name: "Receipt for order DM-1042" });
    expect(within(region).getByText("Order DM-1042")).toBeInTheDocument();
    expect(within(region).getByText(/Pocket Comet/)).toBeInTheDocument();
  });
  it("carries the fiction line and a total", () => {
    render(<Receipt {...props} />);
    expect(screen.getByText("Fictional money · DeluluMart only")).toBeInTheDocument();
    expect(screen.getByText("Total paid")).toBeInTheDocument();
  });
  it("shows a discount row only when discounted", () => {
    const { rerender } = render(<Receipt {...props} />);
    expect(screen.queryByText("Discount")).not.toBeInTheDocument();
    rerender(<Receipt {...props} discountPaise={50_00n} />);
    expect(screen.getByText("Discount")).toBeInTheDocument();
  });
  it("shows the payment status in words when given", () => {
    const { rerender } = render(<Receipt {...props} />);
    expect(screen.queryByText("Payment:")).not.toBeInTheDocument();
    rerender(<Receipt {...props} paymentStatus="Paid" />);
    expect(screen.getByText("Paid")).toBeInTheDocument();
  });
  it("draws a decorative picture beside a line that has one", () => {
    const { container } = render(
      <Receipt
        {...props}
        lines={[
          {
            id: "a",
            name: "Pocket Comet",
            quantity: 1,
            totalPaise: 100n,
            hue: 10,
            imageSrc: "/products/x.webp",
          },
        ]}
      />,
    );
    expect(container.querySelector("img")).toHaveAttribute("src", "/products/x.webp");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
