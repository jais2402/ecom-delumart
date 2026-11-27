import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RecoveryPanel } from "./RecoveryPanel";

const categories = [
  { slug: "impossible-tech", name: "Impossible Tech", href: "/c/impossible-tech", motif: "tech" },
  { slug: "food-fantasies", name: "Food Fantasies", href: "/c/food-fantasies", motif: "food" },
] as const;

function setup(onSearch = vi.fn()) {
  render(
    <RecoveryPanel
      title="We can't find that page"
      message="The address may be mistyped."
      searchAction="/search"
      onSearch={onSearch}
      categories={categories}
    />,
  );
  return onSearch;
}

describe("RecoveryPanel", () => {
  it("has one h1, a way home and the popular departments", () => {
    setup();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "We can't find that page" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to the home page" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("navigation", { name: "Popular departments" })).toHaveTextContent(
      "Impossible Tech",
    );
    expect(screen.getByRole("link", { name: "Food Fantasies" })).toHaveAttribute("href", "/c/food-fantasies");
  });
  it("searches from the keyboard through a field named Search for a product", async () => {
    const onSearch = setup();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search for a product" }), "jar{Enter}");
    expect(onSearch).toHaveBeenCalledWith("jar");
  });
  it("draws a main action before the home link when given one", () => {
    render(
      <RecoveryPanel
        title="Something went wrong"
        message="Try again."
        action={<button type="button">Try again</button>}
        searchAction="/search"
        onSearch={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Popular departments" })).toBeNull();
  });
});
