import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CategoryThumbs } from "./CategoryThumbs";

const categories = [
  { slug: "a", name: "Impossible Tech", href: "/c/a", motif: "tech", hue: 10, seed: "a" },
  { slug: "b", name: "Food Fantasies", href: "/c/b", motif: "food", hue: 20, seed: "b" },
] as const;

describe("CategoryThumbs", () => {
  it("is a labelled navigation with the id the tab bar links to and one link per category", () => {
    render(<CategoryThumbs categories={categories} />);
    const nav = screen.getByRole("navigation", { name: "Shop by category" });
    expect(nav).toHaveAttribute("id", "categories");
    expect(within(nav).getAllByRole("link")).toHaveLength(2);
  });
  it("lets the keyboard walk the categories in order", async () => {
    render(<CategoryThumbs categories={categories} />);
    await userEvent.tab();
    expect(screen.getByRole("link", { name: "Impossible Tech" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("link", { name: "Food Fantasies" })).toHaveFocus();
  });
});
