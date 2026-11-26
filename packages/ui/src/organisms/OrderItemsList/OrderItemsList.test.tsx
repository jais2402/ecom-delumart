import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OrderItemsList } from "./OrderItemsList";

const items = [
  {
    id: "a",
    name: "Pocket Comet",
    hue: 220,
    imageSrc: "/products/pocket-comet.webp",
    note: "Sold by Velvet Rope Co",
  },
  { id: "b", name: "Monsoon in a Jar", hue: 20 },
];

describe("OrderItemsList", () => {
  it("is a region named by its title, listing every item with its note", () => {
    render(<OrderItemsList title="Your items" items={items} />);
    const region = screen.getByRole("region", { name: "Your items" });
    expect(within(region).getAllByRole("listitem")).toHaveLength(2);
    expect(within(region).getByText("Sold by Velvet Rope Co")).toBeInTheDocument();
    expect(within(region).getByRole("heading", { level: 2, name: "Your items" })).toBeInTheDocument();
  });
  it("draws the photo as decoration and generated art when there is none", () => {
    const { container } = render(<OrderItemsList title="Your items" items={items} />);
    expect(container.querySelector("img")).toHaveAttribute("src", "/products/pocket-comet.webp");
    expect(screen.queryByRole("img", { name: "Pocket Comet" })).not.toBeInTheDocument();
  });
  it("keeps the footer interactive", async () => {
    const onClick = vi.fn();
    render(
      <OrderItemsList
        title="Your items"
        items={items}
        footer={
          <button type="button" onClick={onClick}>
            Change your cart
          </button>
        }
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Change your cart" }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
