import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LogoMark } from "./LogoMark";

describe("LogoMark", () => {
  it("is decorative: hidden from assistive technology and not focusable", () => {
    const { container } = render(<LogoMark />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("focusable", "false");
  });
  it("switches colours for the solid band and merges the class name", () => {
    const { container } = render(<LogoMark tone="onBand" className="size-12" />);
    expect(container.querySelector("svg")).toHaveClass("size-12");
    expect(container.querySelector("path")).toHaveClass("fill-fg-on-band");
  });
});
