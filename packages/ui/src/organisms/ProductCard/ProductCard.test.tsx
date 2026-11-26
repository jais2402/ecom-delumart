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
  it("shows the Zap line only for Zap-eligible products, and the stock badge only when given", () => {
    const { rerender } = render(<ProductCard {...base} zapNote="Zap in 10 min" />);
    expect(screen.queryByText("Zap in 10 min")).not.toBeInTheDocument();
    rerender(
      <ProductCard {...base} zapEligible zapNote="Zap in 10 min" stock={{ state: "low", count: 2 }} />,
    );
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
  it("shows the seller and the delivery line it is given, with no tint, border or chip", () => {
    const { container } = render(<ProductCard {...base} deliveryNote="Delivery in about 24 hours" />);
    expect(screen.getByText("Cloud Nine Emporium")).toBeInTheDocument();
    expect(screen.getByText("Delivery in about 24 hours")).toBeInTheDocument();
    expect(container.firstElementChild).not.toHaveClass("border", "bg-surface");
    expect(screen.queryByText("Deal")).not.toBeInTheDocument();
  });
  it("keeps the card a single link target with a two-line clamped title", () => {
    render(<ProductCard {...base} stock={{ state: "sold-out" }} motif="tech" />);
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 3 })).toHaveClass("line-clamp-2", "font-normal");
    expect(screen.getByText("Sold out")).toBeInTheDocument();
  });
  it("shows the hook in small grey text under the name when there is one", () => {
    const { rerender } = render(<ProductCard {...base} />);
    expect(screen.getByText("Rain on demand.")).toHaveClass("text-fg-muted");
    rerender(<ProductCard {...base} hook="" />);
    expect(screen.queryByText("Rain on demand.")).not.toBeInTheDocument();
  });
  it("shows a photo instead of the generated art when given one, with the alt text", () => {
    render(<ProductCard {...base} imageSrc="/products/jar.webp" imageAlt="A glass jar full of clouds" />);
    const img = screen.getByRole("img", { name: "A glass jar full of clouds" });
    expect(img).toHaveAttribute("src", "/products/jar.webp");
    expect(img).toHaveAttribute("loading", "lazy");
  });
  it("shows in-stock as quiet green text and the other states on the picture", () => {
    const { rerender } = render(<ProductCard {...base} stock={{ state: "in-stock" }} />);
    expect(screen.getByText("In stock")).toHaveClass("text-success");
    rerender(<ProductCard {...base} stock={{ state: "sold-out" }} />);
    expect(screen.getByText("Sold out")).toBeInTheDocument();
    expect(screen.queryByText("In stock")).not.toBeInTheDocument();
  });
  it("draws no delivery line when none is given", () => {
    render(<ProductCard {...base} />);
    expect(screen.queryByText(/delivery/i)).not.toBeInTheDocument();
  });
  it("puts a tag on the picture's top-left only for real states: a stock state first, else Zap", () => {
    const { rerender } = render(<ProductCard {...base} stock={{ state: "in-stock" }} />);
    expect(document.querySelector(".top-2.left-2")).toBeNull();
    rerender(<ProductCard {...base} stock={{ state: "in-stock" }} zapEligible />);
    expect(document.querySelector(".top-2.left-2")).toHaveTextContent("Zap");
    rerender(<ProductCard {...base} stock={{ state: "low", count: 2 }} zapEligible />);
    expect(document.querySelector(".top-2.left-2")).toHaveTextContent("Only 2 left");
    rerender(<ProductCard {...base} stock={{ state: "edition", number: 3, of: 10 }} />);
    expect(document.querySelector(".top-2.left-2")).toHaveTextContent("#3 of 10");
  });
  it("shows an overlay control on the picture's top-right, reachable on its own and not inside the link", async () => {
    const onSave = vi.fn();
    render(
      <ProductCard
        {...base}
        overlay={
          <button type="button" aria-label="Save Monsoon in a Jar" onClick={onSave}>
            heart
          </button>
        }
        actions={<button type="button">Add to cart</button>}
      />,
    );
    const save = screen.getByRole("button", { name: "Save Monsoon in a Jar" });
    expect(save.parentElement).toHaveClass("top-1", "right-1", "z-10");
    expect(screen.getByRole("link", { name: "Monsoon in a Jar" })).not.toContainElement(save);
    // tab order follows the picture top to bottom: the heart, the name link, then Add to cart
    await userEvent.tab();
    expect(save).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("link", { name: "Monsoon in a Jar" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Add to cart" })).toHaveFocus();
    await userEvent.click(save);
    expect(onSave).toHaveBeenCalledTimes(1);
  });
  it("gives the action its own full-width row under the price", () => {
    render(<ProductCard {...base} actions={<button type="button">Add to cart</button>} />);
    const row = screen.getByRole("button", { name: "Add to cart" }).parentElement;
    expect(row).toHaveClass("flex-col");
  });
});
