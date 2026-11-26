import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SectionHeading } from "./SectionHeading";

describe("SectionHeading", () => {
  it("renders the title as a heading of the chosen level", () => {
    render(<SectionHeading title="Big flex" headingLevel={2} />);
    expect(screen.getByRole("heading", { level: 2, name: "Big flex" })).toBeInTheDocument();
  });
  it("offers an underlined View all link that is keyboard reachable", async () => {
    render(<SectionHeading title="Big flex" seeAll={{ href: "/search", label: "View all" }} />);
    await userEvent.tab();
    const link = screen.getByRole("link", { name: "View all" });
    expect(link).toHaveFocus();
    expect(link).toHaveClass("underline", "min-h-touch");
  });
  it("shows no link when none is given", () => {
    render(<SectionHeading title="Big flex" />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
  it("puts one muted subtitle line under the bold title, outside the heading", () => {
    render(<SectionHeading title="New arrivals" lead="The latest impossible things." />);
    expect(screen.getByRole("heading", { level: 2, name: "New arrivals" })).toBeInTheDocument();
    expect(screen.getByText("The latest impossible things.")).toHaveClass("text-fg-muted");
  });
});
