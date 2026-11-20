import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProductGrid } from "./ProductGrid";

const item = (id: string, name: string) => ({
  id,
  href: `/p/${id}`,
  name,
  hook: "hook",
  hue: 100,
  pricePaise: 100_00n,
  storeName: "Store",
});

describe("ProductGrid", () => {
  it("renders one list item per product", () => {
    render(<ProductGrid items={[item("a", "Alpha"), item("b", "Beta")]} label="Results" />);
    const list = screen.getByRole("list", { name: "Results" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Beta" })).toBeInTheDocument();
  });
  it("shows an empty state with a heading when there are no products", () => {
    render(<ProductGrid items={[]} emptyTitle="No matches" />);
    expect(screen.getByRole("heading", { name: "No matches" })).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
});
