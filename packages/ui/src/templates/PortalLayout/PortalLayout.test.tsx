import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PortalLayout } from "./PortalLayout";

describe("PortalLayout", () => {
  it("is labelled Partner Portal and places nav, top bar and content", () => {
    render(
      <PortalLayout nav={<nav aria-label="Sections">Nav</nav>} topBar={<span>Signed in as Asha</span>}>
        <h1>Dashboard</h1>
      </PortalLayout>,
    );
    expect(screen.getByRole("banner")).toHaveTextContent("Partner Portal");
    expect(screen.getByText("Signed in as Asha")).toBeInTheDocument();
    expect(within(screen.getByRole("main")).getByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Sections" })).toBeInTheDocument();
  });
  it("names the sidebar landmark and offers a skip link", () => {
    render(<PortalLayout nav={<span>n</span>}>x</PortalLayout>);
    expect(screen.getByRole("complementary", { name: "Partner Portal sections" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#main-content");
  });
});
