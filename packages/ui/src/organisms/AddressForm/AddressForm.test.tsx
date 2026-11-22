import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ADDRESS_NOTICE, AddressForm } from "./AddressForm";

async function fill() {
  await userEvent.type(screen.getByRole("textbox", { name: /Recipient name/ }), "R. K. Sharma");
  await userEvent.type(screen.getByRole("textbox", { name: /Address line 1/ }), "c/o Meena, H.No. 1-2-345/A");
  await userEvent.type(screen.getByRole("textbox", { name: /Address line 2/ }), "Ward No. 7, Old Town");
  await userEvent.type(screen.getByRole("textbox", { name: /City or town/ }), "Hyderabad");
  await userEvent.selectOptions(screen.getByRole("combobox", { name: /State or union territory/ }), "TS");
  await userEvent.type(screen.getByRole("textbox", { name: /PIN code/ }), "500029");
}

describe("AddressForm (PRD R5.2)", () => {
  it("R5.2: shows the notice, labelled fields with address autocomplete only, and no phone field", () => {
    render(<AddressForm onSubmit={() => undefined} />);
    expect(screen.getByText(ADDRESS_NOTICE)).toBeInTheDocument();
    expect(ADDRESS_NOTICE).toMatch(/Nothing will be delivered/);
    expect(ADDRESS_NOTICE).toMatch(/never shown to sellers/);
    expect(ADDRESS_NOTICE).toMatch(/encrypted/);
    const auto = [...document.querySelectorAll("input, select")].map((e) => e.getAttribute("autocomplete"));
    expect(auto).toEqual(
      expect.arrayContaining([
        "name",
        "address-line1",
        "address-line2",
        "address-level2",
        "address-level1",
        "postal-code",
      ]),
    );
    for (const a of auto) expect(a ?? "").not.toMatch(/^cc-|tel|transaction|one-time-code/);
    expect(screen.queryByRole("textbox", { name: /phone|mobile|card/i })).toBeNull();
    expect(screen.getByRole("radio", { name: "Home" })).toBeChecked();
    expect(screen.getByRole("combobox", { name: /State or union territory/ })).toBeInTheDocument();
  });

  it("submits the values of a realistic address", async () => {
    const onSubmit = vi.fn();
    render(<AddressForm onSubmit={onSubmit} />);
    await fill();
    await userEvent.click(screen.getByRole("radio", { name: "Work" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Use as my default address" }));
    await userEvent.click(screen.getByRole("button", { name: "Save address" }));
    expect(onSubmit).toHaveBeenCalledWith({
      label: "WORK",
      makeDefault: true,
      address: {
        recipientName: "R. K. Sharma",
        line1: "c/o Meena, H.No. 1-2-345/A",
        line2: "Ward No. 7, Old Town",
        city: "Hyderabad",
        state: "TS",
        postalCode: "500029",
        country: "IN",
      },
    });
  });

  it("shows inline errors tied to their fields and does not submit", async () => {
    const onSubmit = vi.fn();
    render(<AddressForm onSubmit={onSubmit} />);
    await userEvent.type(screen.getByRole("textbox", { name: /PIN code/ }), "123");
    await userEvent.click(screen.getByRole("button", { name: "Save address" }));
    expect(onSubmit).not.toHaveBeenCalled();
    const pin = screen.getByRole("textbox", { name: /PIN code/ });
    expect(pin).toHaveAttribute("aria-invalid", "true");
    const message = screen.getByText("Enter a 6-digit PIN code.");
    expect(pin.getAttribute("aria-describedby")).toContain(message.id);
    expect(screen.getByRole("textbox", { name: /Recipient name/ })).toHaveFocus();
  });

  it("starts from the initial values, shows server field errors, and can be cancelled", async () => {
    const onCancel = vi.fn();
    render(
      <AddressForm
        onSubmit={() => undefined}
        onCancel={onCancel}
        submitLabel="Save changes"
        showMakeDefault={false}
        initial={{ label: "OTHER", address: { recipientName: "Asha", city: "Pune" } }}
        fieldErrors={{ line1: "Remove links, email addresses or phone numbers." }}
      />,
    );
    expect(screen.getByRole("radio", { name: "Other" })).toBeChecked();
    expect(screen.getByRole("textbox", { name: /City or town/ })).toHaveValue("Pune");
    expect(screen.getByText("Remove links, email addresses or phone numbers.")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });
});
