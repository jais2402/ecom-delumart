import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CategoryMenu } from "./CategoryMenu";

const categories = [
  { slug: "a", name: "Impossible Tech", href: "/c/a", motif: "tech" },
  { slug: "b", name: "Food Fantasies", href: "/c/b", motif: "food" },
] as const;

describe("CategoryMenu", () => {
  it("is a closed Departments button until pressed, then lists one link per category", async () => {
    render(<CategoryMenu categories={categories} />);
    const button = screen.getByRole("button", { name: "Departments" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const nav = screen.getByRole("navigation", { name: "All departments" });
    expect(within(nav).getByRole("link", { name: "Food Fantasies" })).toHaveAttribute("href", "/c/b");
  });
  it("opens with the keyboard, walks the rows with Tab, and Escape closes it and returns focus to the button", async () => {
    render(<CategoryMenu categories={categories} />);
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    await userEvent.tab();
    await userEvent.tab();
    expect(screen.getByRole("link", { name: "Impossible Tech" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Departments" })).toHaveFocus();
  });
});
