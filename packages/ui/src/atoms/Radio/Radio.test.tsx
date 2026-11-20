import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Radio } from "./Radio";

describe("Radio", () => {
  it("renders with its label as accessible name", () => {
    render(<Radio name="x" value="a" label="Option A" />);
    expect(screen.getByRole("radio", { name: "Option A" })).toBeInTheDocument();
  });
  it("selects one of a group", async () => {
    render(
      <>
        <Radio name="x" value="a" label="A" />
        <Radio name="x" value="b" label="B" />
      </>,
    );
    await userEvent.click(screen.getByLabelText("B"));
    expect(screen.getByLabelText("B")).toBeChecked();
    expect(screen.getByLabelText("A")).not.toBeChecked();
  });
  it("can be disabled", () => {
    render(<Radio name="x" value="a" label="A" disabled />);
    expect(screen.getByRole("radio")).toBeDisabled();
  });
});
