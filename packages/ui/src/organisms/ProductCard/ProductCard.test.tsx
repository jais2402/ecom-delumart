import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProductCard } from "./ProductCard";

const base = {
  href: "/p/jar",
  name: "Monsoon in a Jar",
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
  it("keeps the price navy and bold; it turns green with a struck-through Was price only for a real reduction", () => {
    const { rerender } = render(<ProductCard {...base} />);
    expect(screen.queryByText(/Was/)).not.toBeInTheDocument();
    expect(document.querySelector(".text-success")).toBeNull();
    rerender(<ProductCard {...base} referencePricePaise={base.pricePaise + 100_000n} />);
    expect(screen.getByText(/Was/)).toBeInTheDocument();
    expect(document.querySelector(".line-through")).not.toBeNull();
    expect(document.querySelector(".text-success")).not.toBeNull();
  });
  it("shows the seller in small grey text, with no tint, border or chip", () => {
    const { container } = render(<ProductCard {...base} />);
    expect(screen.getByText("Cloud Nine Emporium")).toHaveClass("text-fg-muted");
    expect(container.firstElementChild).not.toHaveClass("border", "bg-surface");
    expect(screen.queryByText("Deal")).not.toBeInTheDocument();
  });
  it("keeps the card a single link target with a two-line clamped title", () => {
    render(<ProductCard {...base} stock={{ state: "sold-out" }} motif="tech" />);
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 3 })).toHaveClass("line-clamp-2", "font-normal");
    expect(screen.getByText("Sold out")).toBeInTheDocument();
  });
  it("shows a hook in small grey text under the name only when one is given", () => {
    const { rerender } = render(<ProductCard {...base} />);
    expect(screen.queryByText("Rain on demand.")).not.toBeInTheDocument();
    rerender(<ProductCard {...base} hook="Rain on demand." />);
    expect(screen.getByText("Rain on demand.")).toHaveClass("text-fg-muted");
  });
  it("draws a rating slot only when given one", () => {
    const { rerender } = render(<ProductCard {...base} />);
    expect(screen.queryByText("4.5 stars")).not.toBeInTheDocument();
    rerender(<ProductCard {...base} rating={<span>4.5 stars</span>} />);
    expect(screen.getByText("4.5 stars")).toBeInTheDocument();
  });
  it("shows a photo instead of the generated art when given one, with the alt text", () => {
    render(<ProductCard {...base} imageSrc="/products/jar.webp" imageAlt="A glass jar full of clouds" />);
    const img = screen.getByRole("img", { name: "A glass jar full of clouds" });
    expect(img).toHaveAttribute("src", "/products/jar.webp");
    expect(img).toHaveAttribute("loading", "lazy");
  });
  it("draws no line for the in-stock state: availability is only worth a tag when it is unusual", () => {
    render(<ProductCard {...base} stock={{ state: "in-stock" }} />);
    expect(screen.queryByText("In stock")).not.toBeInTheDocument();
    expect(document.querySelector(".top-2.left-2")).toBeNull();
  });
  it("puts a soft pink tag on the picture's top-left only for real states: a stock state first, else Zap", () => {
    const { rerender } = render(<ProductCard {...base} stock={{ state: "in-stock" }} />);
    expect(document.querySelector(".top-2.left-2")).toBeNull();
    rerender(<ProductCard {...base} stock={{ state: "in-stock" }} zapEligible />);
    expect(document.querySelector(".top-2.left-2")).toHaveTextContent("Zap");
    expect(document.querySelector(".top-2.left-2")).toHaveClass("bg-accent-soft");
    rerender(<ProductCard {...base} stock={{ state: "low", count: 2 }} zapEligible />);
    expect(document.querySelector(".top-2.left-2")).toHaveTextContent("Only 2 left");
    rerender(<ProductCard {...base} stock={{ state: "edition", number: 3, of: 10 }} />);
    expect(document.querySelector(".top-2.left-2")).toHaveTextContent("Edition #3 of 10");
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
    // tab order follows the card top to bottom: the heart, the action pill, then the name link
    await userEvent.tab();
    expect(save).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Add to cart" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("link", { name: "Monsoon in a Jar" })).toHaveFocus();
    await userEvent.click(save);
    expect(onSave).toHaveBeenCalledTimes(1);
  });
  it("puts the action between the picture and the price", () => {
    render(<ProductCard {...base} actions={<button type="button">Add to cart</button>} />);
    const button = screen.getByRole("button", { name: "Add to cart" });
    const price = screen.getByText("₹4,999").closest("p");
    expect(button.compareDocumentPosition(price as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
