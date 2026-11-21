import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ShopIdentityForm } from "./ShopIdentityForm";

const limits = { handleMin: 3, handleMax: 24, nameMin: 3, nameMax: 40, descriptionMax: 280 };
const handleField = () => screen.getByRole("textbox", { name: /Shop handle/ });

describe("ShopIdentityForm", () => {
  it("shows the rules and the future address, and checks the handle format as you type", async () => {
    render(<ShopIdentityForm limits={limits} submitLabel="Review" onSubmit={() => {}} />);
    expect(handleField()).toHaveAccessibleDescription(/\/store\/your-handle/);
    await userEvent.type(handleField(), "Bad_Handle");
    expect(handleField()).toBeInvalid();
    expect(handleField()).toHaveAccessibleDescription(/Use lowercase letters only/);
    await userEvent.clear(handleField());
    await userEvent.type(handleField(), "good-handle");
    expect(handleField()).toBeValid();
    expect(handleField()).toHaveAccessibleDescription(/\/store\/good-handle/);
  });
  it("does not submit invalid values and submits trimmed valid ones", async () => {
    const onSubmit = vi.fn();
    render(<ShopIdentityForm limits={limits} submitLabel="Review" onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(handleField()).toHaveFocus();
    await userEvent.type(handleField(), "cloud-nine");
    await userEvent.type(screen.getByRole("textbox", { name: /Display name/ }), "  Cloud Nine  ");
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(onSubmit).toHaveBeenCalledWith({
      handle: "cloud-nine",
      displayName: "Cloud Nine",
      description: "",
    });
  });
  it("shows server messages on their field until that field is edited", async () => {
    render(
      <ShopIdentityForm
        limits={limits}
        submitLabel="Review"
        onSubmit={() => {}}
        initial={{ handle: "taken-one", displayName: "Taken", description: "" }}
        fieldErrors={{ handle: ["That handle is taken. Try another."] }}
      />,
    );
    expect(handleField()).toHaveAccessibleDescription(/That handle is taken/);
    await userEvent.type(handleField(), "x");
    expect(handleField()).not.toHaveAccessibleDescription(/That handle is taken/);
  });
  it("keeps the handle read-only when fixed", () => {
    render(
      <ShopIdentityForm
        limits={limits}
        submitLabel="Save"
        handleFixed
        onSubmit={() => {}}
        initial={{ handle: "cloud-nine", displayName: "Cloud Nine", description: "" }}
      />,
    );
    expect(handleField()).toHaveAttribute("readonly");
  });
});
