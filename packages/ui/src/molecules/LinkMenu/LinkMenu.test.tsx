import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { LinkMenu } from "./LinkMenu";

const links = [
  { name: "Your orders", href: "/account/orders" },
  { name: "Your wallet", href: "/account/wallet" },
] as const;

describe("LinkMenu", () => {
  it("is a closed pill button until pressed, then lists one link per row", async () => {
    render(<LinkMenu label="Services" panelLabel="All services" links={links} />);
    const button = screen.getByRole("button", { name: "Services" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const nav = screen.getByRole("navigation", { name: "All services" });
    expect(within(nav).getByRole("link", { name: "Your wallet" })).toHaveAttribute("href", "/account/wallet");
  });
  it("opens with the keyboard and Escape closes it and returns focus to the button", async () => {
    render(<LinkMenu label="Services" panelLabel="All services" links={links} />);
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    // jsdom applies no CSS, so the mobile sheet's close button comes first in the tab order
    await userEvent.tab();
    await userEvent.tab();
    expect(screen.getByRole("link", { name: "Your orders" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Services" })).toHaveFocus();
  });
  it("closes when focus leaves it or the page is pressed outside", async () => {
    render(
      <>
        <LinkMenu label="Services" panelLabel="All services" links={links} />
        <button type="button">Elsewhere</button>
      </>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Services" }));
    await userEvent.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });
});
