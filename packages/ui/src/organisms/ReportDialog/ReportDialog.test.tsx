import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ReportDialog } from "./ReportDialog";

const base = { open: true, onOpenChange: () => {}, targetName: "Pocket Cloud", onSubmit: () => {} };

describe("ReportDialog", () => {
  it("is a dialog named after what is reported, with the reasons as radios", () => {
    render(<ReportDialog {...base} />);
    expect(screen.getByRole("dialog", { name: "Report Pocket Cloud" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(9);
    expect(screen.getByRole("radio", { name: "Something else" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /What is the problem/ })).toBeInTheDocument();
  });
  it("asks for a reason, then sends reason and detail", async () => {
    const onSubmit = vi.fn();
    render(<ReportDialog {...base} onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole("button", { name: "Send report" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Pick the closest reason.");
    await userEvent.click(screen.getByRole("radio", { name: /Scam/ }));
    await userEvent.type(screen.getByLabelText(/More detail/), "It asks for a card");
    expect(screen.getByText(/18 of 500 characters/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Send report" }));
    expect(onSubmit).toHaveBeenCalledWith("SCAM_OR_PAYMENT", "It asks for a card");
  });
  it("confirms with the case reference and the privacy line", () => {
    render(<ReportDialog {...base} reference="RPT-123456" />);
    expect(screen.getByRole("dialog", { name: "Report received" })).toBeInTheDocument();
    expect(screen.getByTestId("report-reference")).toHaveTextContent("RPT-123456");
    expect(screen.getByText("We do not tell the seller who reported.")).toBeInTheDocument();
  });
  it("shows a refusal in words", () => {
    render(<ReportDialog {...base} error="You already reported this." />);
    expect(screen.getByRole("alert")).toHaveTextContent("You already reported this.");
  });
});
