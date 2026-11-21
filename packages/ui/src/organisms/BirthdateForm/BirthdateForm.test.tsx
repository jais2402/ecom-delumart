import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BirthdateForm } from "./BirthdateForm";

const noop = () => Promise.resolve();
const TODAY = "2026-11-21";

async function choose(day: string, month: string, year: string) {
  await userEvent.selectOptions(screen.getByLabelText("Day"), day);
  await userEvent.selectOptions(screen.getByLabelText("Month"), month);
  await userEvent.selectOptions(screen.getByLabelText("Year"), year);
}

describe("BirthdateForm", () => {
  it("groups three labelled selects in a fieldset with a legend and a privacy note", () => {
    render(<BirthdateForm onSubmit={noop} today={TODAY} />);
    expect(screen.getByRole("group", { name: "Date of birth" })).toBeInTheDocument();
    for (const name of ["Day", "Month", "Year"]) {
      expect(screen.getByRole("combobox", { name })).toBeInTheDocument();
    }
    expect(screen.getByText(/Visible only to you/)).toBeInTheDocument();
  });

  it("rejects an under-18 birthdate with the adult message and does not submit", async () => {
    const onSubmit = vi.fn(noop);
    render(<BirthdateForm onSubmit={onSubmit} today={TODAY} />);
    await choose("22", "November", "2008");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onSubmit).not.toHaveBeenCalled();
    const message = screen.getByText("DeluluMart is for adults aged 18 or over.");
    expect(screen.getByRole("group", { name: "Date of birth" }).getAttribute("aria-describedby")).toContain(
      message.id,
    );
  });

  it("asks for all three parts and rejects impossible dates", async () => {
    render(<BirthdateForm onSubmit={noop} today={TODAY} />);
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Choose your day, month and year.")).toBeInTheDocument();
    await choose("31", "February", "2000");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText(/That date does not exist/)).toBeInTheDocument();
  });

  it("submits an ISO date for an adult", async () => {
    const onSubmit = vi.fn(noop);
    render(<BirthdateForm onSubmit={onSubmit} today={TODAY} />);
    await choose("5", "March", "2001");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onSubmit).toHaveBeenCalledWith("2001-03-05");
  });
});
