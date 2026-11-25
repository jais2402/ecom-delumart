import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MobileTabBar } from "./MobileTabBar";

describe("MobileTabBar", () => {
  it("has the four tabs in a labelled navigation, the cart named with its count", () => {
    render(<MobileTabBar cartCount={3} />);
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getAllByRole("link")).toHaveLength(4);
    expect(within(nav).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    expect(within(nav).getByRole("link", { name: "Categories" })).toHaveAttribute("href", "/#categories");
    expect(within(nav).getByRole("link", { name: "Cart, 3 items" })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Account" })).toBeInTheDocument();
  });
  it("says Sign in when signed out, uses the singular for one item and marks the current tab", () => {
    render(<MobileTabBar cartCount={1} accountLabel="Sign in" accountHref="/sign-in" current="cart" />);
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in");
    expect(screen.getByRole("link", { name: "Cart, 1 item" })).toHaveAttribute("aria-current", "page");
  });
  it("is keyboard reachable, with 44px-tall tabs, and hidden from 768px up", async () => {
    render(<MobileTabBar cartCount={0} />);
    await userEvent.tab();
    expect(screen.getByRole("link", { name: "Home" })).toHaveFocus();
    expect(screen.getByRole("link", { name: "Home" })).toHaveClass("min-h-14");
    expect(screen.getByRole("navigation", { name: "Main" })).toHaveClass("md:hidden");
  });
});
