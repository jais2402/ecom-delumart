import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HowItWorks } from "./HowItWorks";

const steps = [
  { title: "Get ₹100 crore", text: "Game money." },
  { title: "Spend it", text: "On impossible things." },
  { title: "Watch it arrive", text: "Simulated couriers." },
];

describe("HowItWorks", () => {
  it("is an ordered list of numbered steps under a heading", () => {
    render(<HowItWorks title="How the game works" steps={steps} />);
    expect(screen.getByRole("region", { name: "How the game works" })).toHaveAttribute("id", "how-it-works");
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByRole("heading", { level: 3, name: "Step 2: Spend it" })).toBeInTheDocument();
  });
  it("merges the class name", () => {
    render(<HowItWorks title="t" steps={steps} className="x-test" />);
    expect(screen.getByRole("region")).toHaveClass("x-test");
  });
});
