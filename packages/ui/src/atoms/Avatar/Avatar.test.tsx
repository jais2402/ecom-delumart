import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Avatar, initialsOf } from "./Avatar";

describe("Avatar", () => {
  it("falls back to initials with the name as accessible name", () => {
    render(<Avatar name="Ada Lovelace" />);
    const img = screen.getByRole("img", { name: "Ada Lovelace" });
    expect(img).toHaveTextContent("AL");
  });
  it("renders an image when src is given", () => {
    render(<Avatar name="Ada" src="/a.png" />);
    expect(screen.getByRole("img", { name: "Ada" })).toHaveAttribute("src", "/a.png");
  });
  it("derives initials sensibly", () => {
    expect(initialsOf("madonna")).toBe("M");
    expect(initialsOf("  grace  brewster hopper ")).toBe("GH");
  });
});
