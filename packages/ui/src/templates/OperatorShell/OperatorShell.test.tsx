import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OperatorShell } from "./OperatorShell";

describe("OperatorShell", () => {
  it("renders a banner with the product label, a named sidebar and the main region", () => {
    render(
      <OperatorShell
        productLabel="Back Office"
        nav={<nav aria-label="Sections">Nav</nav>}
        topBar={<span>Top</span>}
      >
        <h1>Hello</h1>
      </OperatorShell>,
    );
    expect(screen.getByRole("banner")).toHaveTextContent("Back Office");
    expect(screen.getByRole("complementary", { name: "Back Office sections" })).toBeInTheDocument();
    expect(within(screen.getByRole("main")).getByRole("heading", { name: "Hello" })).toBeInTheDocument();
    expect(screen.getByText("Top")).toBeInTheDocument();
  });
  it("offers a skip link to the main region", () => {
    render(
      <OperatorShell productLabel="Back Office" nav={null}>
        x
      </OperatorShell>,
    );
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#main-content");
  });
});
