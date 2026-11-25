import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductRail } from "./ProductRail";

const item = (id: string, name: string) => ({
  id,
  href: `/p/${id}`,
  name,
  hook: "hook",
  hue: 100,
  pricePaise: 100_00n,
  storeName: "Store",
});
const items = [item("a", "Alpha"), item("b", "Beta"), item("c", "Gamma")];

const scrollBy = vi.fn();
beforeEach(() => {
  scrollBy.mockClear();
  // jsdom has no layout: pretend the row is wider than its box so there is somewhere to scroll
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
  Element.prototype.scrollBy = scrollBy as unknown as typeof Element.prototype.scrollBy;
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ProductRail", () => {
  it("is a section named by its heading, with one card per product", () => {
    render(<ProductRail title="Pocket change" items={items} />);
    const region = screen.getByRole("region", { name: "Pocket change" });
    expect(within(region).getAllByRole("listitem")).toHaveLength(3);
    expect(within(region).getByRole("heading", { level: 2, name: "Pocket change" })).toBeInTheDocument();
    expect(within(region).getByRole("heading", { level: 3, name: "Beta" })).toBeInTheDocument();
  });
  it("scrolls with the next and previous buttons, which work from the keyboard", async () => {
    render(<ProductRail title="Big flex" items={items} />);
    const next = screen.getByRole("button", { name: "Next in Big flex" });
    next.focus();
    await userEvent.keyboard("{Enter}");
    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(scrollBy.mock.calls[0]?.[0]).toMatchObject({ behavior: "smooth" });
    expect(scrollBy.mock.calls[0]?.[0].left).toBeGreaterThanOrEqual(0);
  });
  it("keeps the previous button focusable but inert at the start", async () => {
    render(<ProductRail title="Big flex" items={items} />);
    const previous = screen.getByRole("button", { name: "Previous in Big flex" });
    expect(previous).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(previous);
    expect(scrollBy).not.toHaveBeenCalled();
  });
  it("shows placeholders and announces loading while products load", () => {
    render(<ProductRail title="Fresh" items={[]} loading />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading Fresh");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
  it("says so when there is nothing to show, and hides the arrows", () => {
    render(<ProductRail title="Fresh" items={[]} emptyText="Nothing yet." />);
    expect(screen.getByText("Nothing yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
