import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RegistrationReview } from "./RegistrationReview";

const LAKH = 100_000n * 100n;
const base = {
  displayName: "Cloud Nine",
  handle: "cloud-nine",
  feePaise: 5n * LAKH,
  sponsorshipPaise: 0n,
  payablePaise: 5n * LAKH,
  balanceAfterPaise: 9_995n * 10_000n * LAKH,
  sufficient: true,
  onRefresh: () => {},
};

describe("RegistrationReview", () => {
  it("is a named region that says what the fee is and is not", () => {
    render(
      <RegistrationReview {...base}>
        <button type="button">Pay</button>
      </RegistrationReview>,
    );
    const region = screen.getByRole("region", { name: "Company registration review" });
    expect(region).toHaveTextContent("Company registration · virtual fee");
    expect(region).toHaveTextContent("This is a one-time setup fee, not a product purchase.");
    expect(region).toHaveTextContent("This name is held for you for five minutes.");
    expect(region).toHaveTextContent("/store/cloud-nine");
    expect(screen.queryByText("Covered for you")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pay" })).toBeInTheDocument();
  });
  it("shows the sponsorship when there is one", () => {
    render(<RegistrationReview {...base} sponsorshipPaise={5n * LAKH} payablePaise={0n} />);
    expect(screen.getByText("Covered for you")).toBeInTheDocument();
    expect(screen.getByText(/one time only/)).toBeInTheDocument();
  });
  it("when expired offers a fresh quote instead of the payment controls", async () => {
    const onRefresh = vi.fn();
    render(
      <RegistrationReview {...base} expired onRefresh={onRefresh}>
        <button type="button">Pay</button>
      </RegistrationReview>,
    );
    expect(screen.queryByRole("button", { name: "Pay" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Get a fresh quote" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
  it("says so when the balance is not enough", () => {
    render(<RegistrationReview {...base} sufficient={false} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Not enough fictional money");
  });
});
