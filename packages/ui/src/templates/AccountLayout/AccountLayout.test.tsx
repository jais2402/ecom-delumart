import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AccountLayout } from "./AccountLayout";

describe("AccountLayout", () => {
  it("renders header, sidebar, content and footer", () => {
    render(
      <AccountLayout
        header={<header>Head</header>}
        footer={<footer>Foot</footer>}
        sidebar={<nav aria-label="Account">Side</nav>}
      >
        <h1>Orders</h1>
      </AccountLayout>,
    );
    const main = screen.getByRole("main");
    expect(within(main).getByRole("heading", { name: "Orders" })).toBeInTheDocument();
    expect(within(main).getByRole("navigation", { name: "Account" })).toBeInTheDocument();
    expect(screen.getByRole("banner")).toBeInTheDocument();
  });
  it("names the sidebar landmark and keeps the skip link", () => {
    render(
      <AccountLayout header={<header>H</header>} footer={<footer>F</footer>} sidebar={<span>S</span>}>
        x
      </AccountLayout>,
    );
    expect(screen.getByRole("complementary", { name: "Account sections" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Skip to content" })).toBeInTheDocument();
  });
});
