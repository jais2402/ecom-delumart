import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Stat } from "./Stat";

describe("Stat", () => {
  it("pairs a label term with its value", () => {
    render(<Stat label="Orders" value="128" />);
    expect(screen.getByText("Orders").tagName).toBe("DT");
    expect(screen.getByText("128").tagName).toBe("DD");
  });
  it("shows change and as-of text when given", () => {
    render(<Stat label="Orders" value="128" change="+4% vs last week" asOf="As of 9:00 am" />);
    expect(screen.getByText("+4% vs last week")).toBeInTheDocument();
    expect(screen.getByText("As of 9:00 am")).toBeInTheDocument();
  });
  it("omits optional text by default", () => {
    render(<Stat label="Orders" value="128" />);
    expect(screen.getAllByRole("definition")).toHaveLength(1);
  });
});
