import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SectionHeading } from "./SectionHeading";

describe("SectionHeading", () => {
  it("renders the title as a heading of the chosen level", () => {
    render(<SectionHeading title="Big flex" headingLevel={2} />);
    expect(screen.getByRole("heading", { level: 2, name: "Big flex" })).toBeInTheDocument();
  });
  it("offers a see-all link that is keyboard reachable", async () => {
    render(<SectionHeading title="Big flex" seeAll={{ href: "/search", label: "See all" }} />);
    await userEvent.tab();
    expect(screen.getByRole("link", { name: "See all" })).toHaveFocus();
  });
  it("shows no link when none is given", () => {
    render(<SectionHeading title="Big flex" />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
  it("puts a grey lead sentence on the same heading, after the bold title", () => {
    render(<SectionHeading title="New arrivals." lead="The latest impossible things." />);
    const heading = screen.getByRole("heading", {
      level: 2,
      name: "New arrivals. The latest impossible things.",
    });
    expect(heading).toHaveTextContent("The latest impossible things.");
    expect(screen.getByText("The latest impossible things.")).toHaveClass("text-fg-muted");
  });
});
