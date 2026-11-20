import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Label } from "./Label";

describe("Label", () => {
  it("names the control it is bound to", () => {
    render(
      <>
        <Label htmlFor="n">Name</Label>
        <input id="n" />
      </>,
    );
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
  });
  it("announces required state in text", () => {
    render(
      <>
        <Label htmlFor="n" required>
          Name
        </Label>
        <input id="n" />
      </>,
    );
    expect(screen.getByLabelText(/Name.*required/)).toBeInTheDocument();
  });
  it("hides the asterisk from assistive tech", () => {
    render(<Label required>Name</Label>);
    expect(screen.getByText("*")).toHaveAttribute("aria-hidden", "true");
  });
});
