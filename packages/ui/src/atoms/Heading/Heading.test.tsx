import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Heading } from "./Heading";

describe("Heading", () => {
  it("renders the requested semantic level with its name", () => {
    render(<Heading level={3}>Deals</Heading>);
    expect(screen.getByRole("heading", { level: 3, name: "Deals" })).toBeInTheDocument();
  });
  it("keeps visual size independent of level", () => {
    render(
      <Heading level={2} size="sm">
        Small h2
      </Heading>,
    );
    const h = screen.getByRole("heading", { level: 2 });
    expect(h).toHaveClass("text-xl");
    expect(h).not.toHaveClass("text-3xl");
  });
  it("defaults to h2", () => {
    render(<Heading>Default</Heading>);
    expect(screen.getByRole("heading", { level: 2 })).toBeInTheDocument();
  });
});
