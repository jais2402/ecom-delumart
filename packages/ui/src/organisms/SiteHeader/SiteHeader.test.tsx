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
});
