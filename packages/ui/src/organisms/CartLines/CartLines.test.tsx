import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CartLines } from "./CartLines";

const groups = [
  {
    sellerId: "s1",
    sellerName: "Cloud Nine Emporium",
    lines: [{ id: "l1", name: "Teleporting Tiffin Box", hue: 20, quantity: 2, unitPricePaise: 100_00n }],
  },
  {
    sellerId: "s2",
    sellerName: "Velvet Rope Co",
    lines: [{ id: "l2", name: "Pocket Comet", hue: 220, quantity: 1, unitPricePaise: 500_00n }],
  },
];

describe("CartLines", () => {
  it("groups lines by seller", () => {
    render(<CartLines groups={groups} onRemove={() => {}} />);
    const region = screen.getByRole("region", { name: "Sold by Cloud Nine Emporium" });
    expect(within(region).getByText("Teleporting Tiffin Box")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Sold by Velvet Rope Co" })).toBeInTheDocument();
  });
  it("removes a line through a named button", async () => {
    const onRemove = vi.fn();
    render(<CartLines groups={groups} onRemove={onRemove} />);
    await userEvent.click(screen.getByRole("button", { name: "Remove Pocket Comet from cart" }));
    expect(onRemove).toHaveBeenCalledWith("l2");
  });
  it("shows an empty state", () => {
    render(<CartLines groups={[]} onRemove={() => {}} />);
    expect(screen.getByRole("heading", { name: "Your cart is empty" })).toBeInTheDocument();
  });
});
