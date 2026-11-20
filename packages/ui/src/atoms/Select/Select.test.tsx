import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Select } from "./Select";

describe("Select", () => {
  it("is a combobox with an accessible name", () => {
    render(
      <Select aria-label="Sort">
        <option value="a">A</option>
      </Select>,
    );
    expect(screen.getByRole("combobox", { name: "Sort" })).toBeInTheDocument();
  });
  it("changes value on selection", async () => {
    render(
      <Select aria-label="Sort">
        <option value="a">A</option>
        <option value="b">B</option>
      </Select>,
    );
    await userEvent.selectOptions(screen.getByRole("combobox"), "b");
    expect(screen.getByRole("combobox")).toHaveValue("b");
  });
  it("sets aria-invalid when invalid", () => {
    render(
      <Select aria-label="Sort" invalid>
        <option>A</option>
      </Select>,
    );
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-invalid", "true");
  });
});
