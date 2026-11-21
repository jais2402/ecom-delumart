import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OnboardingProgress } from "./OnboardingProgress";

describe("OnboardingProgress", () => {
  it("lists the five steps and marks the current one", () => {
    render(<OnboardingProgress current={2} />);
    const nav = screen.getByRole("navigation", { name: "Sign-up progress" });
    const items = within(nav).getAllByRole("listitem");
    expect(items.map((item) => item.textContent?.replace(/\d|\(completed\)/g, "").trim())).toEqual([
      "Sign in",
      "Phone",
      "Birthdate",
      "PIN",
      "Done",
    ]);
    expect(items[2]).toHaveAttribute("aria-current", "step");
    expect(within(items[0] as HTMLElement).getByText("(completed)")).toBeInTheDocument();
  });
});
