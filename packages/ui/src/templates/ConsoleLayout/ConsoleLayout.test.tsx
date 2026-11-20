import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConsoleLayout } from "./ConsoleLayout";

describe("ConsoleLayout", () => {
  it("is labelled Commerce Console and places nav, top bar and content", () => {
    render(
      <ConsoleLayout nav={<nav aria-label="Sections">Nav</nav>} topBar={<span>Signed in as Asha</span>}>
        <h1>Dashboard</h1>
      </ConsoleLayout>,
    );
    expect(screen.getByRole("banner")).toHaveTextContent("Commerce Console");
    expect(screen.getByText("Signed in as Asha")).toBeInTheDocument();
    expect(within(screen.getByRole("main")).getByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Sections" })).toBeInTheDocument();
  });
  it("names the sidebar landmark and offers a skip link", () => {
    render(<ConsoleLayout nav={<span>n</span>}>x</ConsoleLayout>);
    expect(screen.getByRole("complementary", { name: "Commerce Console sections" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#main-content");
  });
});
