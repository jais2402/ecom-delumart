import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ListingStatus, listingStatusLabel } from "./ListingStatus";

describe("ListingStatus", () => {
  it("shows the status as text with its meaning", () => {
    render(<ListingStatus status="SCREENING" />);
    expect(screen.getByText("Being checked")).toBeInTheDocument();
    expect(screen.getByText("Being checked — usually quick.")).toBeInTheDocument();
  });
  it("lists reasons and the person's reason in plain words", () => {
    render(
      <ListingStatus
        status="REJECTED"
        reasons={["This wording sounds official."]}
        moderationReason="Please use an invented name."
      />,
    );
    expect(screen.getByRole("list", { name: "What to change" })).toHaveTextContent("sounds official");
    expect(screen.getByText(/Please use an invented name/)).toBeInTheDocument();
  });
  it("says approved listings wait for stock, and has a compact form", () => {
    const { rerender } = render(<ListingStatus status="DRAFT" approvedNeedsStock />);
    expect(screen.getByText("Approved, needs stock")).toBeInTheDocument();
    rerender(<ListingStatus status="PUBLISHED" compact />);
    expect(screen.getByText("Published")).toBeInTheDocument();
    expect(screen.queryByText(/Shoppers can see/)).not.toBeInTheDocument();
    expect(listingStatusLabel("HIDDEN")).toBe("Hidden");
  });
});
