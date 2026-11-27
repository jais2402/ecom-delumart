import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { InfoSection } from "./InfoSection";

describe("InfoSection", () => {
  it("renders a titled region at its own anchor", () => {
    render(
      <InfoSection id="delivery" title="Delivery and tracking">
        <p>Orders move through simulated steps.</p>
      </InfoSection>,
    );
    const region = screen.getByRole("region", { name: "Delivery and tracking" });
    expect(region).toHaveAttribute("id", "delivery");
    expect(screen.getByRole("heading", { level: 2, name: "Delivery and tracking" })).toBeInTheDocument();
    expect(screen.getByText("Orders move through simulated steps.")).toBeInTheDocument();
  });
  it("keeps links inside the body keyboard reachable", async () => {
    render(
      <InfoSection id="a" title="A">
        <a href="/search">Browse</a>
      </InfoSection>,
    );
    await userEvent.tab();
    expect(screen.getByRole("link", { name: "Browse" })).toHaveFocus();
  });
});
