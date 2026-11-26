import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ScrollRow } from "./ScrollRow";

describe("ScrollRow", () => {
  it("renders its items and names the previous and next buttons after the row", () => {
    render(
      <ScrollRow label="Top picks">
        <li>One</li>
        <li>Two</li>
      </ScrollRow>,
    );
    expect(screen.getByText("Two")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous in Top picks" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next in Top picks" })).toBeInTheDocument();
  });
  it("scrolls the list by most of its width when Next is pressed, once there is more to see", async () => {
    render(
      <ScrollRow label="Top picks">
        <li>One</li>
      </ScrollRow>,
    );
    const list = screen.getByRole("list");
    const scrollBy = vi.fn();
    list.scrollBy = scrollBy;
    Object.defineProperty(list, "clientWidth", { value: 300, configurable: true });
    Object.defineProperty(list, "scrollWidth", { value: 1000, configurable: true });
    fireEvent.scroll(list);
    const next = screen.getByRole("button", { name: "Next in Top picks" });
    expect(next).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("button", { name: "Previous in Top picks" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await userEvent.click(next);
    expect(scrollBy).toHaveBeenCalledWith(expect.objectContaining({ left: 270 }));
  });
  it("marks the list busy while loading", () => {
    render(
      <ScrollRow label="Top picks" loading>
        <li>One</li>
      </ScrollRow>,
    );
    expect(screen.getByRole("list")).toHaveAttribute("aria-busy", "true");
  });
});
