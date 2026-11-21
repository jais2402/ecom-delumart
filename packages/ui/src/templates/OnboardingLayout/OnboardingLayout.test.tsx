import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { OnboardingLayout } from "./OnboardingLayout";

describe("OnboardingLayout", () => {
  it("renders logo, banner, progress, main content and the fictional-money footer line", () => {
    render(
      <OnboardingLayout banner={<p>Demo banner</p>} progress={<p>Progress slot</p>}>
        <h1>Page</h1>
      </OnboardingLayout>,
    );
    expect(screen.getByRole("link", { name: "DeluluMart" })).toHaveAttribute("href", "/");
    expect(screen.getByText("Demo banner")).toBeInTheDocument();
    expect(screen.getByText("Progress slot")).toBeInTheDocument();
    expect(screen.getByRole("main")).toContainElement(screen.getByRole("heading", { name: "Page" }));
    expect(screen.getByRole("contentinfo")).toHaveTextContent("Fictional money only");
  });

  it("offers a skip link that is the first tab stop", async () => {
    render(
      <OnboardingLayout progress={null}>
        <p>Body</p>
      </OnboardingLayout>,
    );
    await userEvent.tab();
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveFocus();
  });
});
