import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Input } from "../../atoms/Input";
import { FormField } from "./FormField";

describe("FormField", () => {
  it("labels the control", () => {
    render(<FormField label="Email">{(c) => <Input {...c} />}</FormField>);
    expect(screen.getByRole("textbox", { name: "Email" })).toBeInTheDocument();
  });
  it("wires hint and error via aria-describedby and flags invalid", () => {
    render(
      <FormField label="Email" hint="We never email" error="Enter an email">
        {(c) => <Input {...c} />}
      </FormField>,
    );
    const input = screen.getByRole("textbox");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("We never email Enter an email");
  });
  it("is valid and undescribed without hint or error", () => {
    render(<FormField label="Email">{(c) => <Input {...c} />}</FormField>);
    const input = screen.getByRole("textbox");
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).not.toHaveAttribute("aria-describedby");
  });
});
