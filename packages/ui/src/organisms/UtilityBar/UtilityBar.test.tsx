import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { UtilityBar } from "./UtilityBar";

const message = "Zap delivery in about 10 minutes on eligible products";

describe("UtilityBar", () => {
  it("shows one centred message on the brand colour", () => {
    const { container } = render(<UtilityBar message={message} />);
    expect(screen.getByText(message)).toHaveClass("text-center");
    expect(container.firstElementChild).toHaveClass("bg-band", "text-fg-on-band");
  });
  it("offers links that are keyboard reachable and 44px tall, named by their text", async () => {
    render(<UtilityBar message={message} links={[{ label: "How it works", href: "/#how-it-works" }]} />);
    await userEvent.tab();
    const link = screen.getByRole("link", { name: "How it works" });
    expect(link).toHaveFocus();
    expect(link).toHaveClass("h-11");
  });
  it("shows no list of links when none are given, and merges the class name", () => {
    const { container } = render(<UtilityBar message={message} className="x-test" />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass("x-test");
  });
});
