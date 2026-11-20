import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ShopLayout } from "./ShopLayout";

function setup() {
  render(
    <ShopLayout header={<header>Head</header>} footer={<footer>Foot</footer>}>
      <p>Body</p>
    </ShopLayout>,
  );
}

describe("ShopLayout", () => {
  it("places the slots in header, main, footer", () => {
    setup();
    expect(screen.getByRole("banner")).toHaveTextContent("Head");
    expect(screen.getByRole("main")).toHaveTextContent("Body");
    expect(screen.getByRole("contentinfo")).toHaveTextContent("Foot");
  });
  it("makes the skip link the first tab stop and points it at main", async () => {
    setup();
    await userEvent.tab();
    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(skip).toHaveFocus();
    expect(skip).toHaveAttribute("href", "#main-content");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
  });
});
