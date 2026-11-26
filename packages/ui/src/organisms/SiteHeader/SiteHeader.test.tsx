import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SiteHeader } from "./SiteHeader";

describe("SiteHeader", () => {
  it("shows the logo, balance, cart with count and account link", () => {
    render(<SiteHeader balancePaise={10_000_000_000n} cartCount={3} onSearch={() => {}} />);
    expect(screen.getByRole("link", { name: "DeluluMart" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Cart, 3 items" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Account" })).toBeInTheDocument();
    expect(screen.getByText(/fictional money/i)).toBeInTheDocument();
  });
  it("submits the search query", async () => {
    const onSearch = vi.fn();
    render(<SiteHeader balancePaise={100n} cartCount={0} onSearch={onSearch} />);
    await userEvent.type(screen.getByRole("searchbox", { name: "Search" }), "jar{Enter}");
    expect(onSearch).toHaveBeenCalledWith("jar");
  });
  it("uses a singular label for one item and exposes a banner landmark", () => {
    render(<SiteHeader balancePaise={100n} cartCount={1} onSearch={() => {}} />);
    expect(screen.getByRole("link", { name: "Cart, 1 item" })).toBeInTheDocument();
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("search")).toBeInTheDocument();
  });
  it("signed out: shows Sign in, no balance, and no sign-out button", () => {
    render(
      <SiteHeader
        balancePaise={null}
        accountLabel="Sign in"
        accountHref="/sign-in"
        cartCount={0}
        onSearch={() => {}}
      />,
    );
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in");
    expect(screen.queryByText(/fictional money/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });
  it("signed in: the Sign out button is keyboard reachable and calls back", async () => {
    const onSignOut = vi.fn();
    render(<SiteHeader balancePaise={100n} cartCount={0} onSearch={() => {}} onSignOut={onSignOut} />);
    const button = screen.getByRole("button", { name: "Sign out" });
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
  it("shows the Departments and Services pills, the delivery pill and the Saved link only when given", () => {
    const { rerender } = render(<SiteHeader balancePaise={null} cartCount={0} onSearch={() => {}} />);
    expect(screen.queryByRole("button", { name: "Departments" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Saved" })).not.toBeInTheDocument();
    rerender(
      <SiteHeader
        balancePaise={null}
        cartCount={0}
        onSearch={() => {}}
        savedHref="/account/saved"
        categories={[{ slug: "a", name: "Impossible Tech", href: "/c/a", motif: "tech" }]}
        services={[{ name: "Sell on DeluluMart", href: "/sell" }]}
        delivery={{
          label: "Standard or Zap delivery",
          speeds: [{ name: "Zap", arrival: "Arrives in about 10 minutes" }],
          helpHref: "/#how-it-works",
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "Departments" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Services" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Standard or Zap delivery" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Saved" })).toHaveAttribute("href", "/account/saved");
  });
  it("shows the cart total under the cart icon when given, without changing the link's name", () => {
    render(<SiteHeader balancePaise={null} cartCount={2} cartTotalLabel="₹4,999" onSearch={() => {}} />);
    expect(screen.getByRole("link", { name: "Cart, 2 items" })).toHaveTextContent("₹4,999");
  });
  it("makes the search a GET form for visitors without JavaScript when given an action", () => {
    render(<SiteHeader balancePaise={null} cartCount={0} onSearch={() => {}} searchAction="/search" />);
    expect(screen.getByRole("search")).toHaveAttribute("action", "/search");
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveAttribute("name", "q");
  });
  it("hands the account link to the tab bar below 768px when one is used", () => {
    render(<SiteHeader balancePaise={null} cartCount={2} onSearch={() => {}} withTabBar />);
    expect(screen.getByRole("link", { name: "Cart, 2 items" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Account" })).toHaveClass("max-md:hidden");
  });
});
