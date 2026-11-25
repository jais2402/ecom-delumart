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
  it("shows a Sell link only when given an address for it", () => {
    const { rerender } = render(<SiteHeader balancePaise={null} cartCount={0} onSearch={() => {}} />);
    expect(screen.queryByRole("link", { name: "Sell" })).not.toBeInTheDocument();
    rerender(<SiteHeader balancePaise={null} cartCount={0} onSearch={() => {}} sellHref="/sell" />);
    expect(screen.getByRole("link", { name: "Sell" })).toHaveAttribute("href", "/sell");
  });
  it("shows the Categories button, the utility row and the Saved link only when given", () => {
    const { rerender } = render(<SiteHeader balancePaise={null} cartCount={0} onSearch={() => {}} />);
    expect(screen.queryByRole("button", { name: "Categories" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Saved" })).not.toBeInTheDocument();
    rerender(
      <SiteHeader
        balancePaise={null}
        cartCount={0}
        onSearch={() => {}}
        savedHref="/account/saved"
        categories={[{ slug: "a", name: "Impossible Tech", href: "/c/a", motif: "tech" }]}
        utility={{
          items: ["Fictional money only"],
          links: [{ label: "How it works", href: "/#how-it-works" }],
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "Categories" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Saved" })).toHaveAttribute("href", "/account/saved");
    expect(screen.getByText("Fictional money only")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "How it works" })).toBeInTheDocument();
  });
  it("hands cart and account to the tab bar below 768px when one is used", () => {
    render(<SiteHeader balancePaise={null} cartCount={2} onSearch={() => {}} withTabBar />);
    expect(screen.getByRole("link", { name: "Cart, 2 items" })).toHaveClass("max-md:hidden");
    expect(screen.getByRole("link", { name: "Account" })).toHaveClass("max-md:hidden");
  });
});
