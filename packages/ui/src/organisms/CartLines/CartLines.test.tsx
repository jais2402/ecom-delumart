import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CartLines, type CartSellerGroup } from "./CartLines";

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
  it("marks a line with an issue, names the reason and ties it to the remove button", async () => {
    const withIssue = [
      {
        sellerId: "s1",
        sellerName: "Cloud Nine Emporium",
        lines: [
          {
            id: "l1",
            name: "Pocket Comet",
            hue: 220,
            quantity: 1,
            unitPricePaise: 500_00n,
            issue: "Sold out.",
          },
        ],
      },
    ];
    render(<CartLines groups={withIssue} onRemove={() => {}} />);
    expect(screen.getByText("Sold out.")).toBeInTheDocument();
    const remove = screen.getByRole("button", { name: "Remove Pocket Comet from cart" });
    expect(remove).toHaveAccessibleDescription("Sold out.");
    expect(remove.closest("li")).toHaveAttribute("data-issue", "true");
  });
  it("renders a group footer and an empty-state action", () => {
    const withFooter: CartSellerGroup[] = [
      { ...groups[0], footer: <p>Delivery choice</p> } as CartSellerGroup,
    ];
    const { rerender } = render(<CartLines groups={withFooter} onRemove={() => {}} />);
    expect(screen.getByText("Delivery choice")).toBeInTheDocument();
    rerender(<CartLines groups={[]} onRemove={() => {}} emptyAction={<a href="/">Shop</a>} />);
    expect(screen.getByRole("link", { name: "Shop" })).toBeInTheDocument();
  });
  it("shows a product's photo when the line has one, and generated art otherwise", () => {
    const withPhoto = [
      {
        sellerId: "s1",
        sellerName: "Store",
        lines: [
          {
            id: "a",
            name: "Has photo",
            hue: 20,
            quantity: 1,
            unitPricePaise: 100_00n,
            imageSrc: "/products/a.webp",
            imageAlt: "A photo",
          },
          { id: "b", name: "No photo", hue: 40, quantity: 1, unitPricePaise: 100_00n, imageAlt: "Some art" },
        ],
      },
    ];
    render(<CartLines groups={withPhoto} onRemove={() => {}} />);
    expect(screen.getByRole("img", { name: "A photo" })).toHaveAttribute("src", "/products/a.webp");
    expect(screen.getByRole("img", { name: "Some art" }).tagName.toLowerCase()).toBe("svg");
  });
});
