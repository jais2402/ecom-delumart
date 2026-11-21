import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ModerationReviewCard } from "./ModerationReviewCard";

const base = {
  storeName: "Cloud Nine",
  storeHandle: "cloudnine",
  kindLabel: "First submission",
  submittedAt: "21 Nov, 10:00",
  fields: {
    name: "The Official Teapot",
    hook: null,
    description: "A teapot that pours weather.",
    altText: "",
    category: "Impossible Tech",
    mode: "Standard",
    price: "₹2,500",
  },
  reasons: ["This wording sounds official and needs a review before it can be used."],
  preview: <div>card preview</div>,
};

describe("ModerationReviewCard", () => {
  it("shows the store, the submitted text, the reasons and the preview", () => {
    render(<ModerationReviewCard {...base} onDecide={() => {}} />);
    expect(screen.getByRole("article", { name: "The Official Teapot" })).toBeInTheDocument();
    expect(screen.getByText(/From Cloud Nine/)).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Screening reasons" })).toHaveTextContent("sounds official");
    expect(screen.getByRole("region", { name: "Preview as shoppers will see it" })).toHaveTextContent(
      "card preview",
    );
  });
  it("requires a reason of 5 to 500 characters before deciding", async () => {
    const onDecide = vi.fn();
    render(<ModerationReviewCard {...base} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole("button", { name: /Reject/ }));
    expect(onDecide).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Reason/)).toHaveAccessibleDescription(/at least 5 characters/);
    await userEvent.type(screen.getByLabelText(/Reason/), "Sounds like a real brand.");
    await userEvent.click(screen.getByRole("button", { name: /Reject/ }));
    expect(onDecide).toHaveBeenCalledWith("REJECT", "Sounds like a real brand.");
    await userEvent.click(screen.getByRole("button", { name: /Approve/ }));
    expect(onDecide).toHaveBeenLastCalledWith("APPROVE", "Sounds like a real brand.");
  });
  it("names its buttons after the listing", () => {
    render(<ModerationReviewCard {...base} onDecide={() => {}} />);
    expect(screen.getByRole("button", { name: "Approve: The Official Teapot" })).toBeInTheDocument();
  });
});
