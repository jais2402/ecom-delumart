import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProductCard } from "./ProductCard";

const base = {
  href: "/p/jar",
  name: "Monsoon in a Jar",
  hook: "Rain on demand.",
  hue: 210,
  pricePaise: 499_900n,
  storeName: "Cloud Nine Emporium",
};

describe("ProductCard", () => {
  it("is one link named after the product and described by price and store", () => {
    render(<ProductCard {...base} />);
    const link = screen.getByRole("link", { name: "Monsoon in a Jar" });
    expect(link).toHaveAttribute("href", "/p/jar");
    expect(link).toHaveAccessibleDescription(/Cloud Nine Emporium/);
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });
  it("shows the Zap tag and stock badge only when given", () => {
    const { rerender } = render(<ProductCard {...base} />);
    expect(screen.queryByText("Zap in 10 min")).not.toBeInTheDocument();
    rerender(<ProductCard {...base} zapEligible stock={{ state: "low", count: 2 }} />);
    expect(screen.getByText("Zap in 10 min")).toBeInTheDocument();
    expect(screen.getByText("Only 2 left")).toBeInTheDocument();
  });
  it("gives the product art a name when alt text is provided", () => {
    render(<ProductCard {...base} imageAlt="A glass jar full of clouds" />);
    expect(screen.getByRole("img", { name: "A glass jar full of clouds" })).toBeInTheDocument();
  });
  it("renders actions as their own controls, not inside the product link", async () => {
    const onAdd = vi.fn();
    render(
      <ProductCard
        {...base}
        actions={
          <button type="button" onClick={onAdd}>
            Add Monsoon in a Jar to cart
          </button>
        }
      />,
    );
    const button = screen.getByRole("button", { name: "Add Monsoon in a Jar to cart" });
    expect(screen.getByRole("link", { name: "Monsoon in a Jar" })).not.toContainElement(button);
    await userEvent.click(button);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });
  it("shows a struck-through reference price with Was text only when one is given", () => {
    const { rerender } = render(<ProductCard {...base} />);
    expect(screen.queryByText("Was")).not.toBeInTheDocument();
    rerender(<ProductCard {...base} referencePricePaise={base.pricePaise + 100_000n} />);
    expect(screen.getByText(/Was/)).toBeInTheDocument();
    expect(document.querySelector(".line-through")).not.toBeNull();
  });
});
