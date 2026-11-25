import { render, screen } from "@testing-library/react";
import { ShieldCheck } from "lucide-react";
import { describe, expect, it } from "vitest";
import { TrustItem } from "./TrustItem";

describe("TrustItem", () => {
  it("shows the title and the line of detail", () => {
    render(<TrustItem icon={ShieldCheck} title="Fictional money only" text="Nothing here is real." />);
    expect(screen.getByText("Fictional money only")).toBeInTheDocument();
    expect(screen.getByText("Nothing here is real.")).toBeInTheDocument();
  });
  it("keeps the icon out of the accessibility tree and merges the class name", () => {
    const { container } = render(<TrustItem icon={ShieldCheck} title="t" text="x" className="x-test" />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(container.firstElementChild).toHaveClass("x-test");
  });
});
