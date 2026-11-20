import { Home } from "lucide-react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SidebarNav } from "./SidebarNav";

const items = [
  { label: "Overview", href: "/account", icon: Home },
  { label: "Orders", href: "/account/orders" },
];

describe("SidebarNav", () => {
  it("is a named navigation with links", () => {
    render(<SidebarNav label="Account" items={items} />);
    const nav = screen.getByRole("navigation", { name: "Account" });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Orders" })).toHaveAttribute("href", "/account/orders");
  });
  it("marks only the current page with aria-current", () => {
    render(<SidebarNav label="Account" items={items} currentHref="/account/orders" />);
    expect(screen.getByRole("link", { name: "Orders" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current");
  });
  it("keeps icons decorative", () => {
    const { container } = render(<SidebarNav label="Account" items={items} />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});
