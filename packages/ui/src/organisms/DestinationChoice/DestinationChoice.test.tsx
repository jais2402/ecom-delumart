import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DestinationChoice } from "./DestinationChoice";

const options = [
  {
    value: "FICTIONAL_SPOT",
    title: "Fictional delivery spot",
    text: "Cloud Nine Heights",
    kind: "fictional" as const,
  },
  {
    value: "a1",
    title: "Home",
    text: "Asha Rao, Flat 4B, Bengaluru",
    kind: "real" as const,
    isDefault: true,
  },
];

describe("DestinationChoice", () => {
  it("decisions.md #4: a radio group named by its legend; the chosen option is checked", () => {
    render(
      <DestinationChoice name="dest" options={options} value="FICTIONAL_SPOT" onChange={() => undefined} />,
    );
    expect(screen.getByRole("group", { name: "Deliver to" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Fictional delivery spot/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Home/ })).not.toBeChecked();
    expect(screen.getByText("Default")).toBeInTheDocument();
  });
  it("calls onChange with the option's value, by keyboard too", async () => {
    const onChange = vi.fn();
    render(
      <DestinationChoice
        name="dest"
        options={options}
        value="FICTIONAL_SPOT"
        onChange={onChange}
        footer={<a href="/account/addresses">Add a new address</a>}
      />,
    );
    screen.getByRole("radio", { name: /Fictional delivery spot/ }).focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(onChange).toHaveBeenCalledWith("a1");
    expect(screen.getByRole("link", { name: "Add a new address" })).toBeInTheDocument();
  });
});
