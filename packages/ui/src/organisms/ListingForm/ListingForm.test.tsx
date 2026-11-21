import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ListingForm, type ListingFormProps, type ListingFormValues } from "./ListingForm";

const empty: ListingFormValues = {
  name: "",
  hook: "",
  description: "",
  category: "",
  templateId: 200,
  altText: "",
  priceRupees: "",
  inventoryMode: "STANDARD_STOCKED",
  quantity: "1",
  offersExpress: false,
  freeStandardDelivery: false,
};
const categories = [
  { slug: "impossible-tech", name: "Impossible Tech" },
  { slug: "absurd-luxury", name: "Absurd Luxury" },
];

function Harness(props: Partial<ListingFormProps> & { initial?: ListingFormValues }) {
  const [values, setValues] = useState(props.initial ?? empty);
  const { initial: _initial, ...rest } = props;
  return (
    <ListingForm
      values={values}
      onChange={setValues}
      categories={categories}
      warehouse={{ used: 0, capacity: 100 }}
      onSave={() => {}}
      {...rest}
    />
  );
}

const filled: ListingFormValues = {
  ...empty,
  name: "Pocket Thundercloud",
  description: "A small cloud that follows you and rains only on bad news.",
  category: "impossible-tech",
  priceRupees: "250000",
  quantity: "25",
};

describe("ListingForm", () => {
  it("names every control and shows the limits and counts", async () => {
    render(<Harness />);
    expect(screen.getByRole("form", { name: "Listing editor" })).toBeInTheDocument();
    for (const name of [/^Name/, /^Tagline/, /^Description/, /^Category/, /^Template/, /^Price in rupees/]) {
      expect(screen.getByLabelText(name)).toBeInTheDocument();
    }
    expect(screen.getByLabelText(/^Name/)).toHaveAccessibleDescription(/0 of 80 characters \(at least 3\)/);
    await userEvent.type(screen.getByLabelText(/^Name/), "Cloud");
    expect(screen.getByLabelText(/^Name/)).toHaveAccessibleDescription(/5 of 80 characters/);
  });

  it("reads the price in lakh and shows the fee and net", () => {
    render(<Harness initial={filled} />);
    expect(screen.getByTestId("price-reading")).toHaveTextContent("₹2,50,000 = ₹2.5 lakh");
    expect(screen.getByText(/You receive the price minus a 5% marketplace fee/)).toBeInTheDocument();
    expect(screen.getByText(/Fee/)).toHaveTextContent("₹12,500");
    expect(screen.getByText(/Fee/)).toHaveTextContent("₹2,37,500");
  });

  it("shows warehouse space for the quantity", () => {
    render(<Harness initial={filled} />);
    expect(screen.getByLabelText(/^Units to stock/)).toHaveAccessibleDescription(
      "Uses 25 of your 100 slots; 75 free.",
    );
  });

  it("does not save invalid values, shows messages and focuses the first bad field", async () => {
    const onSave = vi.fn();
    render(<Harness onSave={onSave} />);
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/^Name/)).toHaveFocus();
    expect(screen.getByLabelText(/^Name/)).toBeInvalid();
    expect(screen.getByLabelText(/^Name/)).toHaveAccessibleDescription(/Use at least 3 characters/);
    expect(screen.getByLabelText(/^Price in rupees/)).toHaveAccessibleDescription(/whole number of rupees/);
  });

  it("saves valid values and asks to submit for review", async () => {
    const onSave = vi.fn();
    const onSubmit = vi.fn();
    render(<Harness initial={filled} onSave={onSave} onSubmitForReview={onSubmit} />);
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(onSave).toHaveBeenCalledWith(filled);
    await userEvent.click(screen.getByRole("button", { name: "Submit for review" }));
    expect(onSubmit).toHaveBeenCalledWith(filled);
  });

  it("lets the person adopt the suggested picture description", async () => {
    render(<Harness initial={filled} />);
    await userEvent.click(screen.getByRole("button", { name: /Use suggestion: Illustration of Pocket/ }));
    expect(screen.getByLabelText(/^Picture description/)).toHaveValue("Illustration of Pocket Thundercloud");
  });

  it("offers a focusable native slider for the template and announces its value", () => {
    render(<Harness initial={filled} />);
    const slider = screen.getByRole("slider", { name: /^Template/ });
    slider.focus();
    expect(slider).toHaveFocus();
    expect(slider).toHaveAttribute("type", "range");
    fireEvent.change(slider, { target: { value: "202" } });
    expect(slider).toHaveValue("202");
    expect(slider).toHaveAttribute("aria-valuetext", "Template 202 of 359");
  });

  it("says the delivery cost comes out of proceeds", async () => {
    render(<Harness initial={filled} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Free Standard delivery for buyers" }));
    expect(screen.getByText(/comes out of your proceeds/)).toBeInTheDocument();
  });

  it("revise mode only allows text; locked mode allows nothing and shows the reason", () => {
    const { rerender } = render(<Harness initial={filled} mode="revise" />);
    expect(screen.getByLabelText(/^Name/)).toBeEnabled();
    expect(screen.getByLabelText(/^Price in rupees/)).toBeDisabled();
    rerender(<Harness initial={filled} mode="locked" lockedReason="Being checked — usually quick" />);
    expect(screen.getByLabelText(/^Name/)).toBeDisabled();
    expect(screen.getByText("Being checked — usually quick")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save draft" })).not.toBeInTheDocument();
  });
});
