import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { UtilityBar } from "./UtilityBar";

const items = ["Fictional money only", "Delivery is simulated"];

describe("UtilityBar", () => {
  it("lists the plain statements", () => {
    render(<UtilityBar items={items} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Delivery is simulated")).toBeInTheDocument();
  });
  it("offers links that are keyboard reachable and 44px tall", async () => {
    render(<UtilityBar items={items} links={[{ label: "How it works", href: "/#how-it-works" }]} />);
    await userEvent.tab();
    const link = screen.getByRole("link", { name: "How it works" });
    expect(link).toHaveFocus();
    expect(link).toHaveClass("h-11");
  });
});
